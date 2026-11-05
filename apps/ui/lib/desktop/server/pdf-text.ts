import 'server-only'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { DesktopHttpError } from './auth'
import { DESKTOP_PDF_MAX_BYTES } from './pdf-bytes'
import { DESKTOP_PDF_TEXT_MAX_STDOUT, parseDesktopPdfTextExtract, type DesktopPdfTextExtract } from '@/lib/desktop/pdf-text'

export const DESKTOP_PDF_TEXT_TIMEOUT_MS = 8_000
const MAX_STDERR_BYTES = 4096
const MAX_READERS = 2
const readerKey = Symbol.for('rerun.desktop.pdfTextReaders')
const readerHost = globalThis as typeof globalThis & { [readerKey]?: number }

const failed = () => new DesktopHttpError(422, 'Could not read this PDF’s text. The file may be damaged, encrypted, or have no supported text.')
const cancelled = () => new DesktopHttpError(499, 'PDF text was closed.')

function decodeExtract(output: Buffer): DesktopPdfTextExtract {
    if (output.length < 2 || output.length > DESKTOP_PDF_TEXT_MAX_STDOUT || output[output.length - 1] !== 10) throw failed()
    const body = output.subarray(0, output.length - 1)
    if (body.includes(0) || body.includes(10)) throw failed()
    try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
        const extract = parseDesktopPdfTextExtract(value)
        if (!extract) throw failed()
        return extract
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw failed()
    }
}

/** The packaged PDFKit helper receives only bounded bytes on stdin and no path.
 * Stdout is one JSON document. Stderr is counted and never returned. Deadline, output,
 * and abort failures kill the process and await close before releasing its slot.
 * These caps are not an operating-system memory quota. */
export async function extractDesktopPdfText(bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<DesktopPdfTextExtract> {
    if (options.signal?.aborted) throw cancelled()
    if (bytes.byteLength < 1) throw failed()
    if (bytes.byteLength > DESKTOP_PDF_MAX_BYTES) throw new DesktopHttpError(413, 'PDF files can be up to 16 MB.')
    const helper = process.env.RERUN_DESKTOP_PDF_TEXT_HELPER
    if (!helper || !isAbsolute(helper)) throw new DesktopHttpError(503, 'PDF text is unavailable. Reopen the app and try again.')
    if ((readerHost[readerKey] ?? 0) >= MAX_READERS) throw new DesktopHttpError(503, 'Other PDF text is still loading. Try again shortly.')
    readerHost[readerKey] = (readerHost[readerKey] ?? 0) + 1
    let child: ChildProcessWithoutNullStreams
    try {
        child = spawn(helper, [], {
            stdio: ['pipe', 'pipe', 'pipe'], shell: false, cwd: '/',
            env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        })
    } catch {
        readerHost[readerKey] = Math.max(0, (readerHost[readerKey] ?? 1) - 1)
        throw new DesktopHttpError(503, 'PDF text is unavailable. Reopen the app and try again.')
    }
    return new Promise<DesktopPdfTextExtract>((resolve, reject) => {
        let failure: DesktopHttpError | null = null
        let closed = false
        let total = 0
        let stderrBytes = 0
        const chunks: Buffer[] = []
        const stop = (error: DesktopHttpError) => {
            if (closed || failure) return
            failure = error
            chunks.length = 0
            child.stdin.destroy()
            child.kill('SIGKILL')
        }
        const abort = () => stop(cancelled())
        const timer = setTimeout(() => stop(new DesktopHttpError(504, 'This PDF’s text took too long to read.')), DESKTOP_PDF_TEXT_TIMEOUT_MS)
        options.signal?.addEventListener('abort', abort, { once: true })
        child.stdout.on('data', (value: Buffer | string) => {
            if (failure || closed) return
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
            total += chunk.byteLength
            if (total > DESKTOP_PDF_TEXT_MAX_STDOUT) {
                stop(new DesktopHttpError(413, 'PDF text is too large to search.'))
                return
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
        child.on('error', () => stop(new DesktopHttpError(503, 'PDF text is unavailable. Reopen the app and try again.')))
        child.once('close', code => {
            closed = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', abort)
            readerHost[readerKey] = Math.max(0, (readerHost[readerKey] ?? 1) - 1)
            if (failure) { reject(failure); return }
            if (options.signal?.aborted) { reject(cancelled()); return }
            if (code !== 0) { reject(failed()); return }
            try { resolve(decodeExtract(Buffer.concat(chunks, total))) }
            catch (error) { reject(error) }
        })
        if (options.signal?.aborted) abort()
        else child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
}
