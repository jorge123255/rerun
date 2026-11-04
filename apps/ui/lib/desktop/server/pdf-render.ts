import 'server-only'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { DesktopHttpError } from './auth'
import { DESKTOP_PDF_MAX_BYTES } from './pdf-bytes'

export const DESKTOP_PDF_RENDER_TIMEOUT_MS = 8_000
export const DESKTOP_PDF_PNG_MAX_BYTES = 8 * 1024 * 1024
export const DESKTOP_PDF_MAX_PAGE_COUNT = 10_000
const MAX_DIMENSION = 4096
const MAX_PIXELS = 8_000_000
const MAX_HEADER_BYTES = 1024
const MAX_STDERR_BYTES = 4096
const MAX_RENDERERS = 2
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
const rendererKey = Symbol.for('rerun.desktop.pdfRenderers')
const rendererHost = globalThis as typeof globalThis & { [rendererKey]?: number }

export type DesktopPdfRaster = {
    page: number
    pageCount: number
    width: number
    height: number
    pageWidth: number
    pageHeight: number
    png: Uint8Array
}

const failed = () => new DesktopHttpError(422, 'Could not display this PDF page. The file may be damaged, encrypted, or unsupported.')
const cancelled = () => new DesktopHttpError(499, 'PDF preview was closed.')

export function desktopPdfRenderOptions(page = 1, scale = 1): { page: number; scale: number } {
    if (!Number.isSafeInteger(page) || page < 1 || page > DESKTOP_PDF_MAX_PAGE_COUNT) {
        throw new DesktopHttpError(400, 'Choose a valid PDF page.')
    }
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) throw new DesktopHttpError(400, 'Choose a PDF zoom between 50% and 200%.')
    return { page, scale }
}

function decodeRaster(output: Buffer, requestedPage: number): DesktopPdfRaster {
    const newline = output.indexOf(10)
    if (newline < 1 || newline > MAX_HEADER_BYTES) throw failed()
    let info: Record<string, unknown>
    try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, newline)))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed()
        info = value as Record<string, unknown>
    } catch { throw failed() }
    const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
    const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
    if (info.page !== requestedPage || !integer(info.pageCount, DESKTOP_PDF_MAX_PAGE_COUNT) || requestedPage > info.pageCount
        || !integer(info.width, MAX_DIMENSION) || !integer(info.height, MAX_DIMENSION) || info.width * info.height > MAX_PIXELS
        || !positive(info.pageWidth) || !positive(info.pageHeight)) throw failed()
    const png = output.subarray(newline + 1)
    if (png.length < 45 || png.length > DESKTOP_PDF_PNG_MAX_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)
        || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
        || png.readUInt32BE(16) !== info.width || png.readUInt32BE(20) !== info.height
        || !png.subarray(-12).equals(PNG_END)) throw failed()
    return { page: requestedPage, pageCount: info.pageCount, width: info.width, height: info.height,
        pageWidth: info.pageWidth, pageHeight: info.pageHeight, png: new Uint8Array(png) }
}

/** The packaged CoreGraphics helper receives only bounded bytes on stdin and numeric options.
 * No source path, credentials, host converter, network fallback, or PDF document reaches a browser.
 * Deadline/output/abort failures kill the process and await close before releasing its slot. These
 * limits do not claim a hard operating-system memory quota for native PDF decoding. */
export async function renderDesktopPdf(bytes: Uint8Array, options: { page?: number; scale?: number; signal?: AbortSignal } = {}): Promise<DesktopPdfRaster> {
    const { page, scale } = desktopPdfRenderOptions(options.page, options.scale)
    if (options.signal?.aborted) throw cancelled()
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_PDF_MAX_BYTES) throw new DesktopHttpError(413, 'PDF files can be up to 16 MB.')
    const helper = process.env.RERUN_DESKTOP_PDF_HELPER
    if (!helper || !isAbsolute(helper)) throw new DesktopHttpError(503, 'PDF preview is unavailable. Reopen the app and try again.')
    if ((rendererHost[rendererKey] ?? 0) >= MAX_RENDERERS) throw new DesktopHttpError(503, 'Other PDF pages are still loading. Try again shortly.')
    rendererHost[rendererKey] = (rendererHost[rendererKey] ?? 0) + 1
    let child: ChildProcessWithoutNullStreams
    try {
        child = spawn(helper, [String(page), String(scale)], {
            stdio: ['pipe', 'pipe', 'pipe'], shell: false, cwd: '/',
            env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        })
    } catch {
        rendererHost[rendererKey] = Math.max(0, (rendererHost[rendererKey] ?? 1) - 1)
        throw new DesktopHttpError(503, 'PDF preview is unavailable. Reopen the app and try again.')
    }
    return new Promise<DesktopPdfRaster>((resolve, reject) => {
        let failure: DesktopHttpError | null = null
        let closed = false
        let total = 0
        let stderrBytes = 0
        const chunks: Buffer[] = []
        let prefix = Buffer.alloc(0)
        let foundHeader = false
        const stop = (error: DesktopHttpError) => {
            if (closed || failure) return
            failure = error
            chunks.length = 0
            child.stdin.destroy()
            child.kill('SIGKILL')
        }
        const abort = () => stop(cancelled())
        const timer = setTimeout(() => stop(new DesktopHttpError(504, 'This PDF page took too long to display. Try again at a lower zoom.')), DESKTOP_PDF_RENDER_TIMEOUT_MS)
        options.signal?.addEventListener('abort', abort, { once: true })
        child.stdout.on('data', (value: Buffer | string) => {
            if (failure || closed) return
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
            total += chunk.byteLength
            if (total > DESKTOP_PDF_PNG_MAX_BYTES + MAX_HEADER_BYTES + 1) {
                stop(new DesktopHttpError(413, 'This PDF page is too large to display. Try a lower zoom.'))
                return
            }
            if (!foundHeader) {
                prefix = Buffer.concat([prefix, chunk.subarray(0, Math.max(0, MAX_HEADER_BYTES + 1 - prefix.length))])
                const newline = prefix.indexOf(10)
                if (newline < 0 && prefix.length > MAX_HEADER_BYTES) { stop(failed()); return }
                if (newline >= 0) { foundHeader = true; prefix = Buffer.alloc(0) }
            }
            chunks.push(chunk)
        })
        child.stderr.on('data', (value: Buffer | string) => {
            stderrBytes += Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value)
            if (stderrBytes > MAX_STDERR_BYTES) stop(failed())
        })
        child.stdin.on('error', () => stop(failed()))
        child.stdout.on('error', () => stop(failed()))
        child.stderr.on('error', () => stop(failed()))
        child.on('error', () => stop(new DesktopHttpError(503, 'PDF preview is unavailable. Reopen the app and try again.')))
        child.once('close', code => {
            closed = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', abort)
            rendererHost[rendererKey] = Math.max(0, (rendererHost[rendererKey] ?? 1) - 1)
            if (failure) { reject(failure); return }
            if (options.signal?.aborted) { reject(cancelled()); return }
            if (code !== 0) { reject(failed()); return }
            try { resolve(decodeRaster(Buffer.concat(chunks, total), page)) }
            catch (error) { reject(error) }
        })
        if (options.signal?.aborted) abort()
        else child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
}
