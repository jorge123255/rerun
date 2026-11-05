import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { LOGO_FETCH_DEADLINE_MS, fetchWorkspaceLogo } from '@/lib/desktop/server/workspace-logo-fetch'
import { NO_LOGO_FOUND, logoLinkImageUrl, readLogoLink } from '@/lib/desktop/workspace-logo-link'

export const dynamic = 'force-dynamic'

// The preview link is bounded like the engine's URL cap; the body it rides in is counted as
// actual stream bytes, not trusted from Content-Length alone.
const MAX_JSON_BODY_BYTES = 8192
const previewSchema = z.object({ link: z.string().trim().min(1).max(8192) }).strict()

function abortableRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort()
    })
}

async function readPreviewBody(request: Request, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const tooLarge = () => new DesktopHttpError(413, 'Logo preview request is too large.')
    if (Number(request.headers.get('content-length') ?? 0) > MAX_JSON_BODY_BYTES) {
        void request.body?.cancel().catch(() => {})
        throw tooLarge()
    }
    if (!request.body) throw new DesktopHttpError(400, NO_LOGO_FOUND)
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            const chunk = await abortableRead(reader.read(), signal)
            signal.throwIfAborted()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > MAX_JSON_BODY_BYTES) {
                throw tooLarge()
            }
            chunks.push(chunk.value)
        }
    } catch (error) {
        if (signal.aborted) throw signal.reason
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(400, NO_LOGO_FOUND)
    } finally {
        // Cancellation itself can stall. Observe its eventual rejection without extending the
        // request's deadline; abortableRead also observes every late read outcome.
        void reader.cancel().catch(() => {})
        try { reader.releaseLock() } catch { /* Pending cancellation still owns the reader. */ }
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new Response(bytes, { headers: { 'content-type': 'application/json' } }).json().catch(() => null)
}

// Live preview for the "Logo from a website or link" field: classifies the typed link exactly like
// the original form, fetches the target through the desktop web-fetch policy and returns the
// validated static PNG/JPEG/WebP bytes unchanged. Nothing is persisted and no remote address is
// stored; the browser only ever shows a local blob URL of these bytes.
export function POST(request: Request) {
    return desktopRoute(request, async () => {
        if ((request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
            throw new DesktopHttpError(415, 'Send a logo link as JSON.')
        }
        const controller = new AbortController()
        const signal = AbortSignal.any([request.signal, controller.signal])
        const timer = setTimeout(() => controller.abort(new DesktopHttpError(408, 'Logo preview timed out. Try again.')), LOGO_FETCH_DEADLINE_MS)
        try {
            const body = await readPreviewBody(request, signal)
            const parsed = previewSchema.safeParse(body)
            if (!parsed.success) throw new DesktopHttpError(400, NO_LOGO_FOUND)
            const link = readLogoLink(parsed.data.link)
            if (!link) throw new DesktopHttpError(400, NO_LOGO_FOUND)
            const result = await abortableRead(fetchWorkspaceLogo(logoLinkImageUrl(link), signal), signal)
            signal.throwIfAborted()
            if (!result.ok) throw new DesktopHttpError(result.status, result.error)
            return new Response(new Uint8Array(result.bytes), {
                status: 200,
                headers: {
                    'content-type': result.contentType,
                    'content-length': String(result.bytes.byteLength),
                    'x-content-type-options': 'nosniff',
                    'content-security-policy': "default-src 'none'; sandbox",
                    'cross-origin-resource-policy': 'same-origin',
                    // Live validated bytes from a typed link, never a stored or cacheable address.
                    'cache-control': 'private, no-store',
                },
            })
        } catch (error) {
            if (signal.aborted) throw signal.reason instanceof DesktopHttpError ? signal.reason : new DesktopHttpError(499, 'Logo preview cancelled.')
            throw error
        } finally { clearTimeout(timer) }
    })
}
