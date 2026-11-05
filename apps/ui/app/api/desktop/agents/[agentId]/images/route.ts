import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { DESKTOP_IMAGE_MAX_BYTES } from '@/lib/desktop/server/image-bytes'
import { importDesktopComposerImage, readDesktopImageSnapshot } from '@/lib/desktop/server/composer-image-files'
import { desktopImageSnapshotSchema } from '@/lib/desktop/composer-image'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** The multipart envelope is bounded before parsing, including requests without Content-Length. */
async function imageForm(request: Request): Promise<FormData> {
    const maximum = DESKTOP_IMAGE_MAX_BYTES + 64 * 1024
    const declared = request.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data;') || !request.body) throw new DesktopHttpError(400, 'Choose one image to import.')
    const reader = request.body.getReader()
    let rejectStop!: (error: DesktopHttpError) => void
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject })
    const abort = () => rejectStop(new DesktopHttpError(499, 'The image import was cancelled.'))
    const timer = setTimeout(() => rejectStop(new DesktopHttpError(408, 'The image upload timed out. Try again.')), 15_000)
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const part = await Promise.race([reader.read(), stopped])
            if (part.done) break
            size += part.value.byteLength
            if (size > maximum) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
            chunks.push(part.value)
        }
        const body = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
        return await new Response(body, { headers: { 'content-type': request.headers.get('content-type')! } }).formData().catch(() => { throw new DesktopHttpError(400, 'Choose one image to import.') })
    } finally {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        void reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

/** Import one local PNG/JPEG/WebP into the coworker's workspace and pin its bytes for sending. */
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const form = await imageForm(request)
        const file = form.get('file')
        const folder = form.get('path')
        if (!(file instanceof File) || form.getAll('file').length !== 1 || form.getAll('path').length > 1
            || folder !== null && typeof folder !== 'string' || [...form.keys()].some(key => key !== 'file' && key !== 'path')) throw new DesktopHttpError(400, 'Choose one image to import.')
        if (file.size > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
        const result = await importDesktopComposerImage(runtime, agentId, typeof folder === 'string' ? folder : '', file.name, new Uint8Array(await file.arrayBuffer()), { signal: request.signal })
        return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } })
    })
}

/** Authenticated local thumbnail from the exact immutable snapshot, never an arbitrary path. */
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const query = new URL(request.url).searchParams
        const raw = query.get('snapshot')
        if (!raw || raw.length > 32768 || query.getAll('snapshot').length !== 1 || [...query.keys()].some(key => key !== 'snapshot')) throw new DesktopHttpError(400, 'Choose a valid image attachment.')
        let input: unknown
        try { input = JSON.parse(raw) } catch { throw new DesktopHttpError(400, 'Choose a valid image attachment.') }
        const parsed = desktopImageSnapshotSchema.safeParse(input)
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid image attachment.')
        if (request.signal.aborted) throw new DesktopHttpError(499, 'The image preview was closed.')
        const snapshot = await readDesktopImageSnapshot(runtime, agentId, parsed.data)
        if (request.signal.aborted) throw new DesktopHttpError(499, 'The image preview was closed.')
        return new Response(new Uint8Array(snapshot.bytes), { headers: {
            'content-type': parsed.data.mediaType,
            'content-length': String(snapshot.byteLength),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
        } })
    })
}
