import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { ingestDesktopCoworkerShareArchive } from '@/lib/desktop/server/coworker-share/binding'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const MAX_BYTES = 160 * 1024 * 1024
export async function POST(request: Request) {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        if (request.headers.get('content-type') !== 'application/gzip') throw new DesktopHttpError(400,'Choose a portable coworker archive.')
        const declared = request.headers.get('content-length')
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new DesktopHttpError(413,'The coworker archive is too large.')
        // Preserve arbitrary binary bytes; never decode an archive as text.
        const signal = AbortSignal.any([request.signal,AbortSignal.timeout(120_000)])
        const reader = request.body?.getReader()
        if (!reader) throw new DesktopHttpError(400,'Choose a portable coworker archive.')
        const chunks: Uint8Array[] = []; let size = 0
        const abort = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort',abort,{ once: true })
        try {
            for (;;) {
                signal.throwIfAborted()
                const part = await reader.read()
                signal.throwIfAborted()
                if (part.done) break
                size += part.value.byteLength
                if (size > MAX_BYTES) throw new DesktopHttpError(413,'The coworker archive is too large.')
                chunks.push(part.value)
            }
        } finally { signal.removeEventListener('abort',abort); void reader.cancel().catch(() => {}) }
        if (declared && Number(declared) !== size) throw new DesktopHttpError(400,'The coworker archive was incomplete.')
        return Response.json(await ingestDesktopCoworkerShareArchive(runtime,Buffer.concat(chunks,size)),{ headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
        return Response.json({ error: error instanceof DesktopHttpError ? error.message : 'The coworker archive could not be verified.' },{ status: error instanceof DesktopHttpError ? error.status : 400 })
    }
}
