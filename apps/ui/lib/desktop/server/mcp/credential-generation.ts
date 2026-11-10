import 'server-only'
import { createHmac } from 'node:crypto'
import type { OAuthTokenBundle, RemoteMcpStore } from './store'

/**
 * The canonical credential generation of one remote MCP registration, and the one write that may
 * advance it.
 *
 * No generation is minted per read and none is stored beside the credential: the token is a keyed
 * digest of the durable canonical rows — the immutable registration id and revision plus the exact
 * sealed credential row, or `none` before the first credential. It therefore survives restarts,
 * never repeats for a different credential state (the sealed row carries its own IV), and changes
 * on every credential write, every registration edit and every revoke. The token stays private: it
 * only travels inside the encrypted device-review/approval records, never a public view.
 */
export type McpCredentialGenerationLease = {
    /** Opaque, durable generation token. Never logged, displayed or sent to a model. */
    generation: string
    registrationId: string
    revision: string
    validUntil: number
    signal: AbortSignal
    /** Synchronous recheck: same process, still live, before the deadline. */
    check(): void
    dispose(): void
}

export const MCP_CREDENTIAL_GENERATION_TTL_MS = 30 * 60 * 1000

export type McpCredentialGenerationOptions = {
    store: Pick<RemoteMcpStore, 'credentialState' | 'replaceOAuth' | 'lifecycle'>
    key(): Buffer
    ttlMs?: number
    now?: () => number
}

function credentialGenerationToken(key: Buffer, agent: string, name: string, registration: { registrationId: string; revision: string }, sealed: string | null): string {
    return createHmac('sha256', key)
        .update(JSON.stringify(['mcp-credential-generation-v1', agent, name, registration.registrationId, registration.revision, sealed ?? 'none']))
        .digest('base64url')
}

export function createMcpCredentialGeneration({ store, key, ttlMs = MCP_CREDENTIAL_GENERATION_TTL_MS, now = () => Date.now() }: McpCredentialGenerationOptions) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invalid credential generation lifetime.')

    async function current(agent: string, name: string) {
        const state = await store.credentialState(agent, name)
        return state && { ...state, generation: credentialGenerationToken(key(), agent, name, state, state.sealed) }
    }

    return {
        /** The current generation of this registration, or null when there is no device-capable registration. */
        async read(agent: string, name: string, stop?: AbortSignal): Promise<McpCredentialGenerationLease | null> {
            const signal = stop ?? new AbortController().signal
            const watch = store.lifecycle.watchCredentials(agent, name)
            const checkWatch = () => { signal.throwIfAborted(); watch() }
            checkWatch()
            const state = await current(agent, name)
            checkWatch()
            if (!state) return null
            const validUntil = now() + ttlMs
            const expiry = new AbortController()
            const timer = setTimeout(() => expiry.abort(new Error('MCP credential generation expired.')), ttlMs)
            timer.unref?.()
            const combined = AbortSignal.any([signal, expiry.signal])
            const check = () => {
                checkWatch()
                combined.throwIfAborted()
                if (now() >= validUntil) {
                    expiry.abort(new Error('MCP credential generation expired.'))
                    throw new Error('MCP credential generation expired.')
                }
            }
            return {
                generation: state.generation,
                registrationId: state.registrationId,
                revision: state.revision,
                validUntil,
                signal: combined,
                check,
                dispose() { clearTimeout(timer) },
            }
        },

        /**
         * Writes a credential for exactly the approved exchange: the expected token must still be
         * current inside the credential commit, so an unrelated write, revoke, registration edit or
         * disable that landed first refuses this one instead of being overwritten.
         */
        async advance(agent: string, name: string, expected: string, bundle: OAuthTokenBundle, signal: AbortSignal): Promise<{ generation: string }> {
            const before = await current(agent, name)
            if (!before) throw new Error('MCP device registration is unavailable.')
            if (before.generation !== expected) throw new Error('MCP credential generation changed.')
            const sealed = await store.replaceOAuth(agent, name, before, bundle, signal)
            return { generation: credentialGenerationToken(key(), agent, name, before, sealed) }
        },
    }
}

export type McpCredentialGeneration = ReturnType<typeof createMcpCredentialGeneration>
