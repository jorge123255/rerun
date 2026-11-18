import { DESKTOP_WORK_REGISTER_CALL_MAX_BYTES, type DesktopWorkRegisterCall } from '@rerun/contracts'
import { env } from '../../config/env.js'
import { abortable } from '../web-fetch/transport.js'

const MAX_REPLY_BYTES = 256_000

/** A refusal the app explained (no permission, not the owner, a conflict). Its text is for the model. */
export class DesktopWorkRegisterRefusal extends Error {
    constructor(message: string, readonly status: number) { super(message); this.name = 'DesktopWorkRegisterRefusal' }
}

/**
 * One register call to the app on 127.0.0.1, authenticated as the engine. The app holds the
 * register and checks the caller, its permission and its run again; nothing is retried here.
 */
export async function deliverDesktopWorkRegisterCall(call: DesktopWorkRegisterCall, signal: AbortSignal): Promise<unknown> {
    const config = env()
    const url = config.RERUN_HUB_BASE_URL && URL.canParse(config.RERUN_HUB_BASE_URL) ? new URL(config.RERUN_HUB_BASE_URL) : null
    if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY) {
        throw new Error('The work register is unavailable on this Mac.')
    }
    const body = JSON.stringify(call)
    if (Buffer.byteLength(body) > DESKTOP_WORK_REGISTER_CALL_MAX_BYTES) throw new DesktopWorkRegisterRefusal('This register change is too large. Keep it shorter.', 413)
    signal.throwIfAborted()
    const response = await abortable(fetch(`${url.origin}/api/desktop/engine/work-register`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' },
        body, signal, redirect: 'error', credentials: 'omit',
    }), signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('The work register did not answer.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            const part = await abortable(reader.read(), signal)
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_REPLY_BYTES) throw new Error('The work register answer is too large.')
            chunks.push(part.value)
        }
    } finally { void reader.cancel().catch(() => {}) }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as { error?: unknown } | null
    if (!response.ok) {
        const message = typeof parsed?.error === 'string' ? parsed.error.slice(0, 400) : 'The work register refused this change.'
        throw new DesktopWorkRegisterRefusal(message, response.status)
    }
    return parsed
}
