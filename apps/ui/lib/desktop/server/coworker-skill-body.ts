import 'server-only'
import { DesktopHttpError } from './auth'

export const SKILL_BODY_TIMEOUT_MS = 10_000

/** Bound actual JSON bytes and every body read. Cleanup never extends the admission deadline. */
export async function readCoworkerSkillBody(request: Request, limit: number): Promise<unknown> {
    if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new DesktopHttpError(415, 'Send Skills changes as JSON.')
    if (Number(request.headers.get('content-length') ?? 0) > limit) {
        void request.body?.cancel().catch(() => {})
        throw new DesktopHttpError(413, 'This Skills request is too large.')
    }
    if (!request.body) throw new DesktopHttpError(400, 'Send a Skills request.')
    const reader = request.body.getReader()
    const deadline = new AbortController(), signal = AbortSignal.any([request.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(new DesktopHttpError(408, 'Skills request timed out. Try again.')), SKILL_BODY_TIMEOUT_MS)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            signal.throwIfAborted()
            const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
                const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
                signal.addEventListener('abort', abort, { once: true })
                reader.read().then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
                if (signal.aborted) abort()
            })
            signal.throwIfAborted()
            if (part.done) break
            size += part.value.byteLength
            if (size > limit) throw new DesktopHttpError(413, 'This Skills request is too large.')
            chunks.push(part.value)
        }
        try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
        catch { throw new DesktopHttpError(400, 'Send a valid Skills request.') }
    } catch (error) {
        if (signal.aborted) throw signal.reason instanceof DesktopHttpError ? signal.reason : new DesktopHttpError(499, 'Skills request cancelled.')
        throw error
    } finally {
        clearTimeout(timer)
        void reader.cancel().catch(() => {})
        try { reader.releaseLock() } catch { /* Cancellation still owns a pending reader. */ }
    }
}
