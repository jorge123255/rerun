import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { SHARED_IMPORT_BYTES, importDesktopSharedFile, listDesktopSharedFiles } from '@/lib/desktop/server/shared-workspace-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** The workspace shared folder. No agent id, root, or private workspace is accepted. */
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const path = new URL(request.url).searchParams.get('path') ?? ''
        const listing = await listDesktopSharedFiles(runtime, path, { signal: request.signal })
        return Response.json(listing, { headers: { 'cache-control': 'no-store' } })
    })
}

/** Create-only import of one .txt or .md file. An existing name is left unchanged. */
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const form = await request.formData().catch(() => null)
        const file = form?.get('file')
        const folder = form?.get('path')
        if (!(file instanceof File) || form!.getAll('file').length !== 1) throw new DesktopHttpError(400, 'Choose one file to import.')
        if (file.size > SHARED_IMPORT_BYTES) throw new DesktopHttpError(413, 'Files can be up to 1 MB.')
        const result = await importDesktopSharedFile(runtime, typeof folder === 'string' ? folder : '', file.name, new Uint8Array(await file.arrayBuffer()), { signal: request.signal })
        return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } })
    })
}
