import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopWorkspaceIconSelection, writeDesktopWorkspaceIcon, writeDesktopWorkspaceLogoUpload } from '@/lib/desktop/server/workspace-icon'
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

const iconSelection = z.object({
    name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX),
    catalogId: z.string().min(1).max(200).nullable().optional(),
})

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const contentType = request.headers.get('content-type') ?? ''
        // The illustration slice commits name and selection as one JSON payload; the upload slice
        // commits name and raster as one multipart payload, exactly like the original form.
        if (contentType.includes('multipart/form-data')) {
            const form = await request.formData().catch(() => null)
            if (!form) throw new DesktopHttpError(400, 'Choose a workspace name and a logo file.')
            const name = String(form.get('name') ?? '')
            const logo = form.get('logoFile')
            if (!(logo instanceof File)) throw new DesktopHttpError(400, 'Choose a workspace name and a PNG, JPEG or WebP logo file.')
            const saved = await writeDesktopWorkspaceLogoUpload(db, { name, logo })
            return Response.json(saved, { headers: { 'cache-control': 'no-store' } })
        }
        const parsed = iconSelection.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, `Enter a workspace name between 1 and ${WORKSPACE_NAME_MAX} characters and choose a built-in illustration.`)
        const saved = await writeDesktopWorkspaceIcon(db, parsed.data)
        const body = saved.uploadId ? saved : { name: saved.name, catalogId: saved.catalogId }
        return Response.json(body, { headers: { 'cache-control': 'no-store' } })
    })
}
