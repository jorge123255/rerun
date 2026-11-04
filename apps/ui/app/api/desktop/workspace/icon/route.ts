import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopWorkspaceIconUpdateSchema, readDesktopWorkspaceIconSelection, writeDesktopWorkspaceIcon, writeDesktopWorkspaceLogoUpload } from '@/lib/desktop/server/workspace-icon'
import { DESKTOP_IMAGE_MAX_BYTES } from '@/lib/desktop/server/image-bytes'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'

export const dynamic = 'force-dynamic'

// The saved-icon descriptor: the validated catalog selection and/or the uploaded raster's opaque
// identity. The catalog slice's field stays, so existing readers keep working.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const saved = await readDesktopWorkspaceIconSelection(db)
        const body = saved.iconUploadId
            ? { catalogId: null, uploadId: saved.iconUploadId }
            : { catalogId: saved.iconCatalogId }
        return Response.json(body, { headers: { 'cache-control': 'no-store' } })
    })
}

// The file's 8 MiB limit is separate from its bounded multipart envelope. Count the actual
// stream before formData() allocates any uploaded files; Content-Length alone is not trusted.
const MAX_UPLOAD_BODY_BYTES = DESKTOP_IMAGE_MAX_BYTES + 64 * 1024
const MAX_JSON_BODY_BYTES = 4096

async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    const tooLarge = () => new DesktopHttpError(413, 'Workspace settings upload is too large.')
    if (Number(request.headers.get('content-length') ?? 0) > limit) {
        await request.body?.cancel().catch(() => {})
        throw tooLarge()
    }
    if (!request.body) throw new DesktopHttpError(400, 'Choose a workspace name and a logo.')
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            size += chunk.value.byteLength
            if (size > limit) {
                await reader.cancel().catch(() => {})
                throw tooLarge()
            }
            chunks.push(chunk.value)
        }
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(400, 'Could not read workspace settings. Try again.')
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const contentType = request.headers.get('content-type') ?? ''
        const type = contentType.split(';')[0]!.trim().toLowerCase()
        // The illustration slice commits name and selection as one JSON payload; the upload slice
        // commits name and raster as one multipart payload, exactly like the original form.
        if (type === 'multipart/form-data') {
            const bytes = await readBody(request, MAX_UPLOAD_BODY_BYTES)
            const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData().catch(() => null)
            if (!form) throw new DesktopHttpError(400, 'Choose a workspace name and a logo file.')
            if (form.getAll('name').length !== 1 || form.getAll('logoFile').length !== 1
                || [...form.keys()].some(key => key !== 'name' && key !== 'logoFile')) {
                throw new DesktopHttpError(400, 'Send one workspace name and one logo file.')
            }
            const name = form.get('name')
            const logo = form.get('logoFile')
            if (typeof name !== 'string' || !(logo instanceof File)) throw new DesktopHttpError(400, 'Choose a workspace name and a PNG, JPEG or WebP logo file.')
            const db = await openDesktopDatabase(runtime.dataRoot)
            const saved = await writeDesktopWorkspaceLogoUpload(db, { name, logo })
            return Response.json(saved, { headers: { 'cache-control': 'no-store' } })
        }
        if (type !== 'application/json') throw new DesktopHttpError(415, 'Send workspace settings as JSON or a logo upload.')
        const bytes = await readBody(request, MAX_JSON_BODY_BYTES)
        const parsed = desktopWorkspaceIconUpdateSchema.safeParse(await new Response(bytes).json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, `Enter a workspace name between 1 and ${WORKSPACE_NAME_MAX} characters and choose a built-in illustration.`)
        const saved = await writeDesktopWorkspaceIcon(await openDesktopDatabase(runtime.dataRoot), parsed.data)
        const body = saved.uploadId ? saved : { name: saved.name, catalogId: saved.catalogId }
        return Response.json(body, { headers: { 'cache-control': 'no-store' } })
    })
}
