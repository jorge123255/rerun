import 'server-only'
import { DesktopHttpError } from './auth'

export async function readDesktopJson(request: Request, maxBytes: number): Promise<unknown> {
    if (!request.body) throw new DesktopHttpError(400, 'Send a JSON request.')
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
        for (;;) {
            signal.throwIfAborted()
            const part = await reader.read()
            signal.throwIfAborted()
            if (part.done) break
            size += part.value.byteLength
            if (size > maxBytes) throw new DesktopHttpError(413, 'This request is too large.')
            chunks.push(part.value)
        }
        try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
        catch { throw new DesktopHttpError(400, 'Send a valid JSON request.') }
    } finally {
        signal.removeEventListener('abort', abort)
        void reader.cancel().catch(() => {})
    }
}
