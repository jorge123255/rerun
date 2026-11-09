import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { importDesktopSharedOrdinaryFile } from '@/lib/desktop/server/shared-workspace-files'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_FILES = 16
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024
const SUPPORTED = /\.(txt|md|png|jpe?g|gif|webp|wav|mp3|m4a|ogg|flac|mp4|webm|mov|m4v|pdf)$/i

function capFor(name: string): number {
    if (/\.(txt|md)$/i.test(name)) return 1024 * 1024
    if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 8 * 1024 * 1024
    return MAX_FILE_BYTES
}

async function importForm(request: Request, signal: AbortSignal): Promise<FormData> {
    const limit = MAX_TOTAL_BYTES + 64 * 1024
    const type = request.headers.get('content-type') ?? ''
    if (!type.startsWith('multipart/form-data;')) throw new DesktopHttpError(400, 'Choose files to import.')
    const declared = request.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new DesktopHttpError(413, 'This batch is too large.')
    if (!request.body) throw new DesktopHttpError(400, 'Choose files to import.')
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
            if (size > limit) { cancel(); throw new DesktopHttpError(413, 'This batch is too large.') }
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
        throw new DesktopHttpError(400, 'Choose files to import.')
    } finally {
        signal.removeEventListener('abort', cancel)
        reader.releaseLock()
    }
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const form = await importForm(request, signal)
        const entries = form.getAll('file')
        const folder = form.get('path')
        if (!entries.length || entries.length > MAX_FILES) throw new DesktopHttpError(413, `Import 1–${MAX_FILES} files at a time.`)
        if (form.getAll('path').length > 1 || (folder !== null && typeof folder !== 'string')) throw new DesktopHttpError(400, 'Choose a shared folder.')
        const files = entries.filter((file): file is File => file instanceof File)
        if (files.length !== entries.length || files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) throw new DesktopHttpError(413, 'This batch is too large.')
        const destination = typeof folder === 'string' ? folder : ''
        const results: { name: string; folder: string; status: 'created' | 'refused' | 'uncertain'; path?: string; message?: string }[] = []
        for (const file of files) {
            const cap = capFor(file.name)
            if (!SUPPORTED.test(file.name)) { results.push({ name: file.name, folder: destination, status: 'refused', message: 'Choose a supported shared file type.' }); continue }
            if (file.size > cap) { results.push({ name: file.name, folder: destination, status: 'refused', message: `Files of this type can be up to ${cap} bytes.` }); continue }
            try {
                const result = await importDesktopSharedOrdinaryFile(runtime, destination, file.name, new Uint8Array(await file.arrayBuffer()), { signal, maxBytes: cap })
                results.push({ name: file.name, folder: destination, status: 'created', path: result.path })
            } catch (error) {
                if (error instanceof DesktopHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 499) results.push({ name: file.name, folder: destination, status: 'refused', message: error.message })
                else results.push({ name: file.name, folder: destination, status: 'uncertain', message: 'This import could not be confirmed. Inspect Shared files before retrying.' })
            }
        }
        return Response.json({ results }, { status: 201, headers: { 'cache-control': 'no-store' } })
    })
}
