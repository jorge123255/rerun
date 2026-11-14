import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { coworkerWorkspace, withCoworkerFiles } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'
import { FILES_IMPORT_ABORTED, FilesImportError } from '../../../../../../../../engine/src/desktop/files-import/errors'
import { publishFilesImport } from '../../../../../../../../engine/src/desktop/files-import/publish'
import { MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

const tooLarge = () => new FilesImportError(413, `This file is larger than the ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB upload limit.`, 'too_large')
const aborted = () => new FilesImportError(0, FILES_IMPORT_ABORTED, 'aborted')

async function importBytes(request: Request): Promise<Uint8Array> {
    const declared = request.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPLOAD_FILE_BYTES)) {
        void request.body?.cancel().catch(() => {})
        throw tooLarge()
    }
    if (request.signal.aborted) throw aborted()
    const verifySize = (received: number) => {
        if (declared !== null && Number(declared) !== received) {
            throw new DesktopHttpError(400, 'The upload size did not match the file size.')
        }
    }
    const reader = request.body?.getReader()
    if (!reader) {
        verifySize(0)
        return new Uint8Array()
    }
    const cancel = () => { void reader.cancel().catch(() => {}) }
    request.signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            if (request.signal.aborted) throw aborted()
            const part = await reader.read()
            if (request.signal.aborted) throw aborted()
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_UPLOAD_FILE_BYTES) throw tooLarge()
            chunks.push(part.value)
        }
        verifySize(size)
        return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size)
    } catch (error) {
        if (request.signal.aborted) throw aborted()
        throw error
    } finally {
        request.signal.removeEventListener('abort', cancel)
        cancel()
        reader.releaseLock()
    }
}

/** Multi-file import for the Files panel. The one-file text POST stays on the parent route. */
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const path = new URL(request.url).searchParams.get('path') ?? ''
        try {
            const bytes = await importBytes(request)
            const saved = await withCoworkerFiles(runtime, agentId, async () =>
                publishFilesImport(await coworkerWorkspace(runtime, agentId), path, bytes, request.signal))
            return Response.json({ saved: true, path: saved.path, bytes: saved.bytes }, { status: 201, headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof FilesImportError) {
                return Response.json({ error: error.message, code: error.code }, { status: error.status || 400, headers: { 'cache-control': 'no-store' } })
            }
            throw error
        }
    })
}
