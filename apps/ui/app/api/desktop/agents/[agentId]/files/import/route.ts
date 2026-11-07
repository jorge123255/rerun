import { coworkerWorkspace } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'
import { FilesImportError } from '../../../../../../../../engine/src/desktop/files-import/errors'
import { publishFilesImport } from '../../../../../../../../engine/src/desktop/files-import/publish'
import { MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Multi-file import for the Files panel. The one-file text POST stays on the parent route. */
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const path = new URL(request.url).searchParams.get('path') ?? ''
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength > MAX_UPLOAD_FILE_BYTES) {
            return Response.json({ error: `This file is larger than the ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB upload limit.`, code: 'too_large' }, { status: 413, headers: { 'cache-control': 'no-store' } })
        }
        try {
            const saved = await publishFilesImport(await coworkerWorkspace(runtime, agentId), path, bytes, request.signal, () => {})
            return Response.json({ saved: true, path: saved.path, bytes: saved.bytes }, { status: 201, headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof FilesImportError) {
                return Response.json({ error: error.message, code: error.code }, { status: error.status || 400, headers: { 'cache-control': 'no-store' } })
            }
            throw error
        }
    })
}
