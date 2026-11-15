import { z } from 'zod'
import { desktopInternalJson } from '../internal-client.js'

/**
 * Asks the app to type a saved secret into this coworker's browser.
 *
 * The engine names the secret and never receives its value: the app opens it, checks that this
 * run may use it, and sends the keystrokes to the screen itself. The engine holds the screen for
 * the whole request, so nothing else can act on it meanwhile.
 */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

const reply = z.union([
    z.object({ ok: z.literal(true) }).strict(),
    z.object({ ok: z.literal(false), reason: z.string().max(300) }).strict(),
])

export type SecretInputRequest = {
    identity: { engineAgentId: string; sessionId: string; runId: string }
    variable: string
    expectedForeground: { app: 'browser'; windowId: string }
}

export async function typeSecretThroughApp(request: SecretInputRequest, stop: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(60_000)])
    const result = reply.parse(await desktopInternalJson('/api/desktop/internal/type-secret', request, signal, 4096))
    signal.throwIfAborted()
    return result
}
