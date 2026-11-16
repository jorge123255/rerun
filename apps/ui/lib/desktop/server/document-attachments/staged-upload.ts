import 'server-only'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_MAX_BYTES } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'

const PIECE = 1024 * 1024
export const desktopStagedUploadLimitMessage = () => `Files saved to a coworker’s Files can be up to ${DESKTOP_DOCUMENT_STAGED_MAX_BYTES / 1024 / 1024} MB.`

/** A large upload held as one private temporary file, with what was counted while it arrived. */
export type DesktopSpooledUpload = {
    byteLength: number
    sha256: string
    /** The one in-memory copy, kept only when the caller asked for it (a video's structure check). */
    bytes?: Uint8Array
    /** Copies the temporary file into `file`, and fails unless the same bytes come back out. */
    write: (file: FileHandle) => Promise<void>
    dispose: () => Promise<void>
}

/**
 * Receives a request body into a temporary file a piece at a time. The declared size is refused
 * before any byte is read; the counted size stops the transfer the moment it passes the declared
 * size, and must equal it at the end. Nothing is parsed, unpacked or run. With `keep`, the pieces
 * are also copied into one buffer of the declared size, which is the only whole copy in memory.
 */
export async function spoolDesktopStagedUpload(body: ReadableStream<Uint8Array>, declared: number, signal: AbortSignal, keep = false): Promise<DesktopSpooledUpload> {
    if (!Number.isSafeInteger(declared) || declared > DESKTOP_DOCUMENT_STAGED_MAX_BYTES) { void body.cancel().catch(() => {}); throw new DesktopHttpError(413, desktopStagedUploadLimitMessage()) }
    if (declared <= DESKTOP_DOCUMENT_MAX_BYTES) { void body.cancel().catch(() => {}); throw new DesktopHttpError(400, 'This upload is for files larger than 16 MB.') }
    signal.throwIfAborted()
    // mkdtemp makes a folder only this user can enter; the file in it is created, never reused.
    const folder = await mkdtemp(join(tmpdir(), 'rerun-attachment-'))
    const path = join(folder, 'upload')
    const dispose = () => rm(folder, { recursive: true, force: true }).then(() => {}, () => {})
    const reader = body.getReader()
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    const hash = createHash('sha256')
    const kept = keep ? Buffer.allocUnsafe(declared) : undefined
    let count = 0
    try {
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
            while (true) {
                signal.throwIfAborted()
                const part = await reader.read()
                signal.throwIfAborted()
                if (part.done) break
                // The declared size is within the limit, so this also stops a body that runs past the limit.
                if (count + part.value.byteLength > declared) throw new DesktopHttpError(400, 'The upload is larger than the size it declared. Nothing was saved.')
                kept?.set(part.value, count)
                hash.update(part.value)
                for (let written = 0; written < part.value.byteLength;) written += (await file.write(part.value, written, part.value.byteLength - written, count + written)).bytesWritten
                count += part.value.byteLength
            }
            if (count !== declared) throw new DesktopHttpError(400, 'The upload ended before the whole file arrived. Nothing was saved.')
        } finally { await file.close() }
    } catch (error) {
        await dispose()
        throw error
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}) }
    const sha256 = hash.digest('hex')
    return {
        byteLength: count, sha256, ...(kept && { bytes: kept }), dispose,
        async write(target) {
            const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
            try {
                const check = createHash('sha256'), piece = Buffer.allocUnsafe(PIECE)
                let offset = 0
                while (offset <= count) {
                    signal.throwIfAborted()
                    const part = await source.read(piece, 0, piece.byteLength, offset)
                    if (!part.bytesRead) break
                    check.update(piece.subarray(0, part.bytesRead))
                    for (let written = 0; written < part.bytesRead;) written += (await target.write(piece, written, part.bytesRead - written, offset + written)).bytesWritten
                    offset += part.bytesRead
                }
                if (offset !== count || check.digest('hex') !== sha256) throw new DesktopHttpError(409, 'The upload changed while it was saved. Attach the file again.')
            } finally { await source.close() }
        },
    }
}
