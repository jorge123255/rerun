import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { SHARED_IMPORT_BYTES, importDesktopSharedFile, listDesktopSharedFiles } from '@/lib/desktop/server/shared-workspace-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Bound multipart bytes before asking the parser to materialize any file. Checking
// File.size after request.formData() alone accepts an unbounded request into memory.
async function importForm(request: Request, signal: AbortSignal): Promise<FormData> {
    const limit = SHARED_IMPORT_BYTES + 64 * 1024
    const type = request.headers.get('content-type') ?? ''
    if (!type.startsWith('multipart/form-data;')) throw new DesktopHttpError(400, 'Choose one file to import.')
    const declared = request.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new DesktopHttpError(413, 'Files can be up to 1 MB.')
    if (!request.body) throw new DesktopHttpError(400, 'Choose one file to import.')
    const reader = request.body.getReader()
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    try {
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            signal.throwIfAborted()
            if (done) break
            size += value.byteLength
            if (size > limit) { cancel(); throw new DesktopHttpError(413, 'Files can be up to 1 MB.') }
            chunks.push(value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        const form = await new Response(bytes, { headers: { 'content-type': type } }).formData()
        signal.throwIfAborted()
        return form
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        if (signal.aborted) throw new DesktopHttpError(request.signal.aborted ? 499 : 408, 'The shared file import was cancelled. Refresh Shared files before trying again.')
        throw new DesktopHttpError(400, 'Choose one file to import.')
    } finally {
        signal.removeEventListener('abort', cancel)
        reader.releaseLock()
    }
}

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
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const form = await importForm(request, signal)
        const file = form.get('file')
        const folder = form.get('path')
        if (!(file instanceof File) || form.getAll('file').length !== 1) throw new DesktopHttpError(400, 'Choose one file to import.')
        if (form.getAll('path').length > 1 || (folder !== null && typeof folder !== 'string')) throw new DesktopHttpError(400, 'Choose a shared folder.')
        if (file.size > SHARED_IMPORT_BYTES) throw new DesktopHttpError(413, 'Files can be up to 1 MB.')
        const result = await importDesktopSharedFile(runtime, typeof folder === 'string' ? folder : '', file.name, new Uint8Array(await file.arrayBuffer()), { signal })
        return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } })
    })
}
