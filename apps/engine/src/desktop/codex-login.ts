import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { CodexModelReasoning, DesktopCodexStatus } from '@rerun/contracts'
import { createConnection, patchConnection, updateConnectionKeys } from '../connections/store.js'
import { findConnection } from '../connections/registry.js'
import { clearBoxDefault, readBoxDefault, replaceBoxDefaultIfCurrent, writeBoxDefault } from '../connections/default.js'
import { CodexAuthClient } from './codex-rpc.js'
import { DESKTOP_CODEX_ID, signedInFlag } from './codex-runtime.js'

const started = z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string(), userCode: z.string().min(1), verificationUrl: z.literal('https://auth.openai.com/codex/device') })
const completed = z.object({ loginId: z.string(), success: z.boolean(), error: z.string().nullish() })
const catalogPage = z.object({
    data: z.array(z.object({
        model: z.string().min(1), hidden: z.boolean(), isDefault: z.boolean(),
        supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })).default([]),
        defaultReasoningEffort: z.string().min(1).nullish(),
    })),
    nextCursor: z.string().min(1).nullish(),
})
const loginLifetime = 15 * 60_000
// This is a presence marker, not a token. The CLI stores and refreshes its own credential in Keychain.
let state: DesktopCodexStatus | undefined
let client: CodexAuthClient | undefined
let loginId: string | undefined
let timeout: NodeJS.Timeout | undefined
let pending = Promise.resolve()
let lastRefresh = 0

function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = pending.then(action)
    pending = result.then(() => {}, () => {})
    return result
}

function release() {
    clearTimeout(timeout)
    const previous = client
    client = undefined
    loginId = undefined
    previous?.close()
}

function fail(message: string) {
    release()
    state = { phase: 'error', message }
    return state
}

async function readModelCatalog(reader: CodexAuthClient) {
    const models = new Map<string, CodexModelReasoning[string]>()
    const seenCursors = new Set<string>()
    let preferred: string | undefined
    let cursor: string | undefined
    do {
        const page = catalogPage.parse(await reader.request('model/list', { cursor, limit: 100, includeHidden: false }))
        for (const entry of page.data) {
            if (entry.hidden || models.has(entry.model)) continue
            const supported = [...new Set(entry.supportedReasoningEfforts.map(option => option.reasoningEffort))]
            const recommended = entry.defaultReasoningEffort
            models.set(entry.model, { supported, ...(recommended && supported.includes(recommended) && { default: recommended }) })
            if (entry.isDefault) preferred ??= entry.model
        }
        cursor = page.nextCursor ?? undefined
        if (cursor && seenCursors.has(cursor)) throw new Error('The Codex model list repeated a page.')
        if (cursor) seenCursors.add(cursor)
    } while (cursor)
    const available = [...models.keys()]
    if (!available.length) throw new Error('No available Codex models.')
    return { available, preferred: preferred ?? available[0]!, codexReasoning: Object.fromEntries(models) }
}

// A fresh worker sees a just-approved account and checks the runner's catalog independently of the chat worker.
async function restoreAccount(): Promise<boolean> {
    const reader = new CodexAuthClient(() => {}, () => {})
    let stage = 'read the saved account from Keychain'
    try {
        await reader.initialize()
        const account = await reader.request('account/read', { refreshToken: false })
        if (!z.object({ account: z.object({ type: z.literal('chatgpt') }) }).safeParse(account).success) return false

        stage = 'load the ChatGPT model list'
        const { available, preferred, codexReasoning } = await readModelCatalog(reader)
        const keys = { [signedInFlag]: '1' }
        stage = 'save the ChatGPT connection in this workspace'
        const existing = await findConnection(DESKTOP_CODEX_ID)
        const alreadyConnected = existing?.env[signedInFlag] === '1'
        if (existing) {
            if (!isDeepStrictEqual(available, existing.config.models) || !isDeepStrictEqual(codexReasoning, existing.config.codexReasoning)) {
                await patchConnection(DESKTOP_CODEX_ID, { models: available, codexReasoning })
            }
            if (!alreadyConnected) await updateConnectionKeys(DESKTOP_CODEX_ID, { set: keys, remove: [] })
        } else {
            await createConnection({ name: 'ChatGPT (Codex)', provider: 'codex', models: available, codexReasoning, extraModels: [], keys }, DESKTOP_CODEX_ID)
        }
        stage = 'set the default ChatGPT model'
        const recommended = { connectionId: DESKTOP_CODEX_ID, model: preferred }
        const current = await readBoxDefault()
        if (!alreadyConnected) {
            await writeBoxDefault(recommended)
            lastRefresh = Date.now()
        } else if (!current || (current.connectionId === DESKTOP_CODEX_ID && !available.includes(current.model))) {
            const effort = current?.reasoningEffort
            const fallback = effort && codexReasoning[preferred]?.supported.includes(effort) ? { ...recommended, reasoningEffort: effort } : recommended
            await replaceBoxDefaultIfCurrent(current, fallback)
        } else if (current.connectionId === DESKTOP_CODEX_ID && current.reasoningEffort && !codexReasoning[current.model]?.supported.includes(current.reasoningEffort)) {
            await replaceBoxDefaultIfCurrent(current, { connectionId: DESKTOP_CODEX_ID, model: current.model })
        }
        state = { phase: 'connected' }
        return true
    } catch {
        throw new Error(`Could not ${stage}.`)
    } finally {
        reader.close()
    }
}

function newClient() {
    const owner = new CodexAuthClient((method, params) => {
        if (method !== 'account/login/completed') return
        void serial(async () => {
            const event = completed.safeParse(params)
            if (client !== owner || !event.success || event.data.loginId !== loginId) return
            if (!event.data.success) {
                fail(/keychain|keyring|secure storage|save.*credential/i.test(event.data.error ?? '')
                    ? 'Codex could not save the login to the Mac Keychain. Unlock it and request a new code.'
                    : 'Codex could not complete device sign-in. Request a new code to try again.')
                return
            }
            release()
            try {
                if (!await restoreAccount()) fail('The account is not ready yet. Retry setup to use the saved login.')
            } catch (error) { fail((error as Error).message) }
        })
    }, () => {
        if (client === owner) fail('The Codex sign-in process stopped. Request a new code.')
    })
    client = owner
    return owner
}

export async function codexLoginStatus(): Promise<DesktopCodexStatus> {
    return state ?? { phase: (await findConnection(DESKTOP_CODEX_ID))?.env[signedInFlag] === '1' ? 'connected' : 'idle' }
}

export function codexLoginAction(action: 'start' | 'cancel' | 'logout' | 'refresh') {
    return serial(async (): Promise<DesktopCodexStatus> => {
        if (action === 'refresh') {
            const current = await codexLoginStatus()
            if (current.phase !== 'connected') return current
            try {
                if (!await restoreAccount()) throw new Error('Codex could not read the signed-in ChatGPT account.')
            } catch (error) {
                return { phase: 'connected', catalogError: (error as Error).message }
            }
            return { phase: 'connected' }
        }
        if (action === 'cancel') {
            if (client && loginId) await client.request('account/login/cancel', { loginId }).catch(() => {})
            release()
            state = undefined
            return codexLoginStatus()
        }
        if (action === 'start' && state?.phase === 'waiting') return state
        release()
        if (action === 'start') {
            try {
                if (await restoreAccount()) return { phase: 'connected' }
            } catch (error) { return fail((error as Error).message) }
        }
        try {
            const owner = newClient()
            await owner.initialize()
            if (action === 'logout') {
                lastRefresh = 0
                await owner.request('account/logout', {})
                if (await findConnection(DESKTOP_CODEX_ID)) await updateConnectionKeys(DESKTOP_CODEX_ID, { set: {}, remove: [signedInFlag] })
                if ((await readBoxDefault())?.connectionId === DESKTOP_CODEX_ID) await clearBoxDefault()
                release()
                return state = { phase: 'idle' }
            }
            const auth = started.parse(await owner.request('account/login/start', { type: 'chatgptDeviceCode' }))
            loginId = auth.loginId
            state = { phase: 'waiting', userCode: auth.userCode, verificationUrl: auth.verificationUrl, expiresAt: Date.now() + loginLifetime }
            timeout = setTimeout(() => { void serial(async () => { if (client === owner) fail('This code expired. Request a new sign-in code.') }) }, loginLifetime)
            return state
        } catch {
            return fail(action === 'logout' ? 'Could not sign out of ChatGPT. Try again.' : 'Could not start device sign-in. Check your network and try again.')
        }
    })
}

// Keep native chat processes read-only on the Keychain. Only this account-only process
// refreshes managed tokens. Coalesce concurrent turns and revalidate after a restart.
export function prepareDesktopCodexChat() {
    return serial(async () => {
        if (Date.now() - lastRefresh < 5 * 60_000) return
        const owner = new CodexAuthClient(() => {}, () => {})
        try {
            await owner.initialize()
            const account = await owner.request('account/read', { refreshToken: true })
            if (!z.object({ account: z.object({ type: z.literal('chatgpt') }) }).safeParse(account).success)
                throw new Error('Please reconnect ChatGPT in Settings.')
            lastRefresh = Date.now()
        } finally { owner.close() }
    })
}

export function stopCodexLogin() { release() }
