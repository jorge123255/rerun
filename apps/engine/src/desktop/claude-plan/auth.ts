import { createHash, randomBytes, randomUUID, createHmac } from 'node:crypto'
import { z } from 'zod'
import { DEFAULT_CONNECTION_MODELS, DESKTOP_CLAUDE_CONNECTION_ID as ID, DESKTOP_CLAUDE_PLAN_AUTH_LIFETIME_MS, desktopClaudePlanActionSchema, type DesktopClaudePlanAction, type DesktopClaudePlanSnapshot, type DesktopClaudePlanCredential } from '@rerun/contracts'
import { connectionEnvPath } from '../../config/paths.js'
import { readEnvFile, writeEnvFile } from '../../lib/env-file.js'
import { createConnection } from '../../connections/store.js'
import { findConnection, reloadConnection } from '../../connections/registry.js'
import { withConnectionLock } from '../../connections/lock.js'
import { forgetCredentialRejected } from '../../connections/credential-rejections.js'
import { forgetPlanLimits } from '../../connections/plan-limits.js'
import { desktopClaudeAvailable, stopDesktopClaudeWorkers } from './runtime.js'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REDIRECT = 'https://platform.claude.com/oauth/code/callback'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const AUTH = 'RERUN_CLAUDE_LOGIN_STATE', GENERATION = 'RERUN_CLAUDE_CREDENTIAL_REVISION'
const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN', REFRESH = 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', EXPIRES = 'CLAUDE_CODE_OAUTH_EXPIRES_AT'
const stateSchema = z.object({
    attemptId: z.string().uuid(), revision: z.string(), phase: z.enum(['waiting', 'checking', 'connected', 'cancelled', 'expired', 'error', 'disconnected']),
    startId: z.string().uuid(), expires: z.number(), verifier: z.string().optional(), state: z.string().optional(), authorizeUrl: z.string().optional(),
    requestId: z.string().uuid().optional(), fingerprint: z.string().optional(), predecessor: z.string(), launchNonce: z.string(),
}).strict()
type State = z.infer<typeof stateSchema>
export type ClaudeAuthPorts = {
    read(): Promise<Record<string, string>>
    write(value: Record<string, string>): Promise<void>
    lock<T>(work: () => Promise<T>): Promise<T>
    exchange(code: string, verifier: string, state: string, signal: AbortSignal): Promise<DesktopClaudePlanCredential>
    fingerprint(value: string): string
    available(): boolean
    beforeCredentialChange(): Promise<void>
    changed(): Promise<void>
    now(): number
    launchNonce: string
}
/** Attempt phase after passive expiry / interrupted-checking rules. */
function attemptPhaseOf(state: State, now: number, launch: string): State['phase'] {
    if (state.phase === 'waiting' && state.expires <= now) return 'expired'
    if (state.phase === 'checking' && state.launchNonce !== launch) return 'error'
    return state.phase
}

/**
 * Project durable credential generation separately from any in-flight replacement.
 * A still-executable token always publishes phase `connected` + credentialRevision;
 * start/cancel/failure of a replacement must not hide that generation.
 */
export function projectDesktopClaudePlanSnapshot(state: State | null, env: Record<string, string>, now: number, launch: string): DesktopClaudePlanSnapshot {
    const hasCredential = Boolean(env[TOKEN])
    const credentialRevision = hasCredential ? (env[GENERATION] ?? '0') : undefined
    if (!state) {
        return {
            connectionId: ID, attemptId: null, revision: '0',
            phase: hasCredential ? 'connected' : 'idle',
            ...(credentialRevision ? { credentialRevision } : {}),
        }
    }
    const attemptPhase = attemptPhaseOf(state, now, launch)
    if (hasCredential) {
        const pending = (attemptPhase === 'waiting' || attemptPhase === 'checking')
            ? {
                attemptId: state.attemptId,
                phase: attemptPhase,
                ...(attemptPhase === 'waiting' && state.expires > now && state.authorizeUrl ? { authorizeUrl: state.authorizeUrl } : {}),
                ...(attemptPhase === 'checking' && state.launchNonce !== launch ? { error: 'Sign-in was interrupted. Start a new attempt.' } : {}),
            }
            : undefined
        const replacementError = !pending && (attemptPhase === 'error' || (state.phase === 'checking' && state.launchNonce !== launch))
            ? (attemptPhase === 'error' && state.phase === 'error'
                ? 'Claude sign-in could not be confirmed. Start a new attempt.'
                : 'Sign-in was interrupted. Start a new attempt.')
            : undefined
        return {
            connectionId: ID,
            attemptId: pending?.attemptId ?? null,
            revision: state.revision,
            phase: 'connected',
            credentialRevision: credentialRevision!,
            ...(pending?.authorizeUrl ? { authorizeUrl: pending.authorizeUrl } : {}),
            ...(pending ? { pendingAttempt: { attemptId: pending.attemptId, phase: pending.phase, ...(pending.authorizeUrl ? { authorizeUrl: pending.authorizeUrl } : {}), ...(pending.error ? { error: pending.error } : {}) } } : {}),
            ...(replacementError ? { error: replacementError } : {}),
        }
    }
    return {
        connectionId: ID, attemptId: state.attemptId, revision: state.revision,
        phase: attemptPhase === 'connected' ? 'connected' : attemptPhase === 'disconnected' ? 'disconnected' : attemptPhase === 'cancelled' ? 'cancelled' : attemptPhase === 'expired' ? 'expired' : attemptPhase === 'error' ? 'error' : attemptPhase === 'checking' ? 'checking' : attemptPhase === 'waiting' ? 'waiting' : 'idle',
        ...(attemptPhase === 'waiting' && state.expires > now && state.authorizeUrl ? { authorizeUrl: state.authorizeUrl } : {}),
        ...(attemptPhase === 'error' || (state.phase === 'checking' && state.launchNonce !== launch)
            ? { error: state.phase === 'checking' && state.launchNonce !== launch ? 'Sign-in was interrupted. Start a new attempt.' : 'Claude sign-in could not be confirmed. Start a new attempt.' }
            : {}),
    }
}

const publicState = projectDesktopClaudePlanSnapshot
function load(env: Record<string, string>): State | null { return env[AUTH] ? stateSchema.parse(JSON.parse(env[AUTH])) : null }
const next = (state: State, patch: Partial<State>): State => ({ ...state, ...patch, revision: String(BigInt(state.revision) + 1n) })
// Mutations carry the public identity. A linked generation has no pending attempt even
// though its durable audit state still retains the UUID of the completed attempt.
const same = (state: DesktopClaudePlanSnapshot, action: DesktopClaudePlanAction) => state.attemptId === action.attemptId && state.revision === action.expectedRevision
const safeFailure = () => new Error('Claude sign-in could not be confirmed. Check the saved state before trying again.')

export function createDesktopClaudePlanAuth(ports: ClaudeAuthPorts) {
    const exchanges = new Map<string, AbortController>()
    let stopped = false
    const live = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (stopped) throw new Error('Claude sign-in is stopping.') }
    async function status(): Promise<DesktopClaudePlanSnapshot> {
        const env = await ports.read()
        return publicState(load(env), env, ports.now(), ports.launchNonce)
    }
    async function action(raw: DesktopClaudePlanAction, signal: AbortSignal): Promise<DesktopClaudePlanSnapshot> {
        const input = desktopClaudePlanActionSchema.parse(raw)
        live(signal)
        if (['start', 'complete', 'token'].includes(input.operation) && !ports.available()) throw new Error('The isolated Claude runtime is unavailable.')
        let exchange: { state: State; code: string; controller: AbortController } | undefined
        const initial = await ports.lock(async () => {
            live(signal)
            const env = await ports.read(), current = load(env)
            if (current?.requestId === input.requestId && current.fingerprint === ports.fingerprint(JSON.stringify(input))) return publicState(current, env, ports.now(), ports.launchNonce)
            if (input.operation === 'start' && current?.startId === input.requestId) return publicState(current, env, ports.now(), ports.launchNonce)
            if (!same(publicState(current, env, ports.now(), ports.launchNonce), input)) throw new Error('This Claude sign-in changed. Refresh it before continuing.')
            const revision = String(BigInt(current?.revision ?? '0') + 1n)
            if (input.operation === 'start') {
                if (current) exchanges.get(current.attemptId)?.abort()
                const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url')
                const params = new URLSearchParams({ code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: 'org:create_api_key user:profile user:inference', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state })
                const created: State = { attemptId: randomUUID(), startId: input.requestId, revision, phase: 'waiting', expires: ports.now() + DESKTOP_CLAUDE_PLAN_AUTH_LIFETIME_MS, verifier, state, authorizeUrl: `https://claude.ai/oauth/authorize?${params}`, predecessor: env[GENERATION] ?? '0', launchNonce: ports.launchNonce }
                live(signal); await ports.write({ ...env, [AUTH]: JSON.stringify(created) })
                return publicState(created, env, ports.now(), ports.launchNonce)
            }
            if (input.operation === 'cancel') {
                if (!current || !['waiting', 'checking'].includes(current.phase)) return publicState(current, env, ports.now(), ports.launchNonce)
                exchanges.get(current.attemptId)?.abort()
                // Durable token stays executable: end the pending attempt without publishing cancelled over connected.
                const cancelled = next(current, {
                    phase: env[TOKEN] ? 'connected' : 'cancelled',
                    verifier: undefined, state: undefined, authorizeUrl: undefined,
                    requestId: input.requestId, fingerprint: ports.fingerprint(JSON.stringify(input)),
                })
                await ports.write({ ...env, [AUTH]: JSON.stringify(cancelled) })
                return publicState(cancelled, env, ports.now(), ports.launchNonce)
            }
            if (input.operation === 'disconnect') {
                if (current) exchanges.get(current.attemptId)?.abort()
                if (current?.phase === 'checking') throw new Error('Cancel this sign-in before disconnecting.')
                const disconnected: State = { ...(current ?? { attemptId: randomUUID(), startId: input.requestId, predecessor: env[GENERATION] ?? '0', expires: 0, launchNonce: ports.launchNonce }), revision, phase: 'disconnected', requestId: input.requestId, fingerprint: ports.fingerprint(JSON.stringify(input)), verifier: undefined, state: undefined, authorizeUrl: undefined }
                for (const key of [TOKEN, REFRESH, EXPIRES]) delete env[key]
                env[GENERATION] = String(BigInt(env[GENERATION] ?? '0') + 1n); env[AUTH] = JSON.stringify(disconnected)
                live(signal); await ports.beforeCredentialChange(); live(signal); await ports.write(env); await ports.changed()
                return publicState(disconnected, env, ports.now(), ports.launchNonce)
            }
            if (input.operation === 'token') {
                if (!/^sk-ant-oat[a-z0-9-]*-[A-Za-z0-9_-]{20,}$/.test(input.token)) throw new Error('Paste a Claude setup-token value, not an API key.')
                if (current) exchanges.get(current.attemptId)?.abort()
                const connected: State = { ...(current ?? { attemptId: randomUUID(), startId: input.requestId, predecessor: env[GENERATION] ?? '0', expires: 0, launchNonce: ports.launchNonce }), revision, phase: 'connected', requestId: input.requestId, fingerprint: ports.fingerprint(JSON.stringify(input)), verifier: undefined, state: undefined, authorizeUrl: undefined }
                env[TOKEN] = input.token; delete env[REFRESH]; delete env[EXPIRES]
                env[GENERATION] = String(BigInt(env[GENERATION] ?? '0') + 1n); env[AUTH] = JSON.stringify(connected)
                live(signal); await ports.beforeCredentialChange(); live(signal); await ports.write(env); await ports.changed()
                return publicState(connected, env, ports.now(), ports.launchNonce)
            }
            if (!current || current.phase !== 'waiting' || !current.verifier || !current.state || current.expires <= ports.now()) throw new Error('This sign-in expired. Open Claude again.')
            const checking = next(current, { phase: 'checking', requestId: input.requestId, fingerprint: ports.fingerprint(JSON.stringify(input)), launchNonce: ports.launchNonce })
            const controller = new AbortController()
            exchanges.set(current.attemptId, controller)
            exchange = { state: checking, code: input.code, controller }
            live(signal); await ports.write({ ...env, [AUTH]: JSON.stringify(checking) })
            return publicState(checking, env, ports.now(), ports.launchNonce)
        })
        if (!exchange) return initial
        const pending = exchange
        try {
            const signalOfExchange = AbortSignal.any([signal, pending.controller.signal, AbortSignal.timeout(30000)])
            const credential = await ports.exchange(pending.code, pending.state.verifier!, pending.state.state!, signalOfExchange)
            return await ports.lock(async () => {
                live(signalOfExchange)
                const env = await ports.read(), current = load(env)
                if (!current || current.attemptId !== pending.state.attemptId || current.revision !== pending.state.revision || current.phase !== 'checking' || (env[GENERATION] ?? '0') !== pending.state.predecessor) throw safeFailure()
                const connected = next(current, { phase: 'connected', verifier: undefined, state: undefined, authorizeUrl: undefined })
                env[TOKEN] = credential.accessToken
                if (credential.refreshToken) env[REFRESH] = credential.refreshToken; else delete env[REFRESH]
                if (credential.expiresAt) env[EXPIRES] = String(credential.expiresAt); else delete env[EXPIRES]
                env[GENERATION] = String(BigInt(env[GENERATION] ?? '0') + 1n); env[AUTH] = JSON.stringify(connected)
                live(signalOfExchange); await ports.beforeCredentialChange(); live(signalOfExchange); await ports.write(env); await ports.changed()
                return publicState(connected, env, ports.now(), ports.launchNonce)
            })
        } catch {
            await ports.lock(async () => {
                const env = await ports.read(), current = load(env)
                if (!current || current.attemptId !== pending.state.attemptId || current.revision !== pending.state.revision || current.phase !== 'checking') return
                // Never delete TOKEN here. AUTH records error; public projection stays connected when a
                // durable credential remains, with an explicit error for the failed replacement.
                const failed = next(current, { phase: 'error', verifier: undefined, state: undefined, authorizeUrl: undefined })
                await ports.write({ ...env, [AUTH]: JSON.stringify(failed) })
            })
            return status()
        } finally { if (exchanges.get(pending.state.attemptId) === pending.controller) exchanges.delete(pending.state.attemptId) }
    }
    return { status, action, stop: () => { stopped = true; for (const controller of exchanges.values()) controller.abort() } }
}

async function exchangeCode(raw: string, verifier: string, state: string, signal: AbortSignal): Promise<DesktopClaudePlanCredential> {
    const [code, suppliedState, extra] = raw.trim().split('#')
    if (!code || extra || suppliedState && suppliedState !== state) throw safeFailure()
    const response = await fetch(TOKEN_URL, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, state: suppliedState ?? state, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: verifier }) })
    if (!response.ok) { await response.body?.cancel(); throw safeFailure() }
    const reader = response.body?.getReader(); if (!reader) throw safeFailure()
    let text = '', length = 0
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 32768) throw safeFailure(); text += new TextDecoder().decode(chunk.value) } }
    finally { await reader.cancel().catch(() => {}) }
    const value = z.object({ access_token: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/), refresh_token: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/).optional(), expires_in: z.number().positive().max(366 * 86400).optional() }).parse(JSON.parse(text))
    return { accessToken: value.access_token, refreshToken: value.refresh_token, ...(value.expires_in ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}) }
}
export function bindDesktopClaudePlanAuth(launchNonce: string) {
    const ensure = async () => { if (!await findConnection(ID)) await createConnection({ name: 'Claude', provider: 'claude', models: DEFAULT_CONNECTION_MODELS.claude, extraModels: [], keys: {} }, ID) }
    return createDesktopClaudePlanAuth({
        launchNonce, available: desktopClaudeAvailable, now: Date.now,
        read: async () => (await findConnection(ID)) ? readEnvFile(connectionEnvPath(ID)) : {},
        write: async value => { await ensure(); await writeEnvFile(connectionEnvPath(ID), value) },
        lock: work => withConnectionLock(ID, work), exchange: exchangeCode,
        fingerprint: value => { const key = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''; if (!/^[a-f0-9]{64}$/.test(key)) throw safeFailure(); return createHmac('sha256', Buffer.from(key, 'hex')).update(value).digest('hex') },
        beforeCredentialChange: stopDesktopClaudeWorkers,
        changed: async () => { forgetCredentialRejected(ID); forgetPlanLimits(ID); await reloadConnection(ID) },
    })
}
