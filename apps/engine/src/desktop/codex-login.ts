import { z } from 'zod'
import type { DesktopCodexStatus } from '@rerun/contracts'
import { createConnection, patchConnection, updateConnectionKeys } from '../connections/store.js'
import { findConnection } from '../connections/registry.js'
import { clearBoxDefault, readBoxDefault, writeBoxDefault } from '../connections/default.js'
import { CodexAuthClient } from './codex-rpc.js'
import { DESKTOP_CODEX_ID, signedInFlag } from './codex-runtime.js'

const started = z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string(), userCode: z.string().min(1), verificationUrl: z.literal('https://auth.openai.com/codex/device') })
const completed = z.object({ loginId: z.string(), success: z.boolean() })
const catalog = z.object({ data: z.array(z.object({ model: z.string().min(1), hidden: z.boolean(), isDefault: z.boolean() })) })
const loginLifetime = 15 * 60_000
// This is a presence marker, not a token. The CLI stores and refreshes its own credential in Keychain.
let state: DesktopCodexStatus | undefined
let client: CodexAuthClient | undefined
let loginId: string | undefined
let timeout: NodeJS.Timeout | undefined
let pending = Promise.resolve()

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

async function accept(owner: CodexAuthClient) {
    const account = await owner.request('account/read', { refreshToken: false })
    if (!z.object({ account: z.object({ type: z.literal('chatgpt') }) }).safeParse(account).success)
        throw new Error('The runner has no ChatGPT account.')
    const models = catalog.parse(await owner.request('model/list', { limit: 100 })).data.filter(m => !m.hidden)
    const preferred = models.find(m => m.isDefault) ?? models[0]
    if (!preferred) throw new Error('ChatGPT returned no available models.')
    const available = [...new Set(models.map(m => m.model))]
    const keys = { [signedInFlag]: '1' }
    if (await findConnection(DESKTOP_CODEX_ID)) {
        await patchConnection(DESKTOP_CODEX_ID, { models: available })
        await updateConnectionKeys(DESKTOP_CODEX_ID, { set: keys })
    } else {
        await createConnection({ name: 'ChatGPT (Codex)', provider: 'codex', models: available, extraModels: [], keys }, DESKTOP_CODEX_ID)
    }
    await writeBoxDefault({ connectionId: DESKTOP_CODEX_ID, model: preferred.model })
    state = { phase: 'connected' }
    release()
}

function newClient() {
    const owner = new CodexAuthClient((method, params) => {
        if (method !== 'account/login/completed') return
        void serial(async () => {
            const event = completed.safeParse(params)
            if (client !== owner || !event.success || event.data.loginId !== loginId) return
            if (!event.data.success) { fail('ChatGPT did not approve this sign-in. Request a new code to try again.'); return }
            try { await accept(owner) } catch { fail('Could not finish ChatGPT sign-in. Check Keychain access and try again.') }
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

export function codexLoginAction(action: 'start' | 'cancel' | 'logout') {
    return serial(async (): Promise<DesktopCodexStatus> => {
        if (action === 'cancel') {
            if (client && loginId) await client.request('account/login/cancel', { loginId }).catch(() => {})
            release()
            state = undefined
            return codexLoginStatus()
        }
        if (action === 'start' && state?.phase === 'waiting') return state
        release()
        try {
            const owner = newClient()
            await owner.initialize()
            if (action === 'logout') {
                await owner.request('account/logout', {})
                if (await findConnection(DESKTOP_CODEX_ID)) await updateConnectionKeys(DESKTOP_CODEX_ID, { remove: [signedInFlag] })
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

export function stopCodexLogin() { release() }
