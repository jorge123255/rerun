import { isIP } from 'node:net'
import { z } from 'zod'
import { deadlineSignal } from '../../lib/abort.js'
import { isFailureStatus } from '../../tools/host-breaker.js'
import { isPublicAddress, publicUrl } from '../web-fetch/public-url.js'
import { DownloadPermissionError, DownloadTooLargeError } from './errors.js'
import { DOWNLOAD_DEADLINE_MS, DOWNLOAD_LIMIT_BYTES } from './limits.js'
import { downloadPathParts, EXECUTABLE_DOWNLOAD_MESSAGE, isExecutableContentType } from './path.js'
import { publishDownload } from './publish.js'
import type { DownloadResult, PublicBinaryReader } from './types.js'

export const downloadInputSchema = z.object({
    url: z.string().min(1).max(8192),
    path: z.string().min(1).max(4096).describe('Workspace-relative destination path'),
}).strict()

export type DownloadDependencies = {
    signal: AbortSignal
    workspaceRoot: string
    read: PublicBinaryReader
    assertPermission: () => Promise<void>
}

/** String and IP-literal admission only. Hostname DNS stays inside the bound reader. */
export function admitPublicDownloadUrl(value: string): URL {
    const url = publicUrl(value)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && !isPublicAddress(host)) throw new Error('Destination does not resolve exclusively to public addresses')
    return url
}

function refused(error: unknown, signal: AbortSignal, deadline: AbortSignal, url: string): DownloadResult {
    if (signal.aborted) throw error
    if (error instanceof DownloadPermissionError) throw error
    if (error instanceof DownloadTooLargeError) return { text: error.message, failed: false, saved: false }
    if (error instanceof Error && error.message === EXECUTABLE_DOWNLOAD_MESSAGE) return { text: error.message, failed: true, saved: false }
    const reason = deadline.aborted ? `timed out after ${Math.round(DOWNLOAD_DEADLINE_MS / 1000)} s` : error instanceof Error ? error.message : 'Download failed'
    return { text: `Download failed: ${reason} (${url})`, failed: true, saved: false }
}

/**
 * One public-file download. The reader runs at most once. Cancellation throws and does not publish.
 * A saved result is returned only after the workspace link is confirmed.
 */
export async function executeDownload(input: unknown, deps: DownloadDependencies): Promise<DownloadResult> {
    deps.signal.throwIfAborted()
    const parsed = downloadInputSchema.parse(input)
    downloadPathParts(parsed.path)
    const url = admitPublicDownloadUrl(parsed.url)
    deps.signal.throwIfAborted()
    await deps.assertPermission()
    deps.signal.throwIfAborted()
    const deadline = deadlineSignal(DOWNLOAD_DEADLINE_MS, deps.signal)
    let body
    try {
        body = await deps.read(url, deadline, deps.assertPermission)
    } catch (error) {
        return refused(error, deps.signal, deadline, parsed.url)
    }
    if (deps.signal.aborted) throw deps.signal.reason ?? new Error('Cancelled')
    try {
        admitPublicDownloadUrl(body.finalUrl)
    } catch (error) {
        return refused(error, deps.signal, deadline, parsed.url)
    }
    if (body.bytes.byteLength > DOWNLOAD_LIMIT_BYTES) return { text: new DownloadTooLargeError(body.bytes.byteLength).message, failed: false, saved: false }
    if (body.status < 200 || body.status >= 300) {
        return { text: `Download failed: [${body.status}] ${parsed.url}`, failed: isFailureStatus(body.status), saved: false }
    }
    if (isExecutableContentType(body.contentType)) return { text: EXECUTABLE_DOWNLOAD_MESSAGE, failed: true, saved: false }
    if (deps.signal.aborted) throw deps.signal.reason ?? new Error('Cancelled')
    if (deadline.aborted) return { text: `Download failed: timed out after ${Math.round(DOWNLOAD_DEADLINE_MS / 1000)} s (${parsed.url})`, failed: true, saved: false }
    await deps.assertPermission()
    if (deps.signal.aborted) throw deps.signal.reason ?? new Error('Cancelled')
    try {
        await publishDownload(deps.workspaceRoot, parsed.path, body.bytes, deadline)
    } catch (error) {
        if (deps.signal.aborted) throw error
        if (error instanceof DownloadTooLargeError) return { text: error.message, failed: false, saved: false }
        const message = error instanceof Error ? error.message : 'Download failed'
        const kept = message.includes('existing file was kept') || message.includes('outside') || message.includes('reserved') || message.includes('could not be confirmed') || message.includes('another user') || message.includes('only available on this Mac') || message === EXECUTABLE_DOWNLOAD_MESSAGE
        if (!kept && deadline.aborted) return { text: `Download failed: timed out after ${Math.round(DOWNLOAD_DEADLINE_MS / 1000)} s (${parsed.url})`, failed: true, saved: false }
        return { text: message, failed: true, saved: false }
    }
    if (deps.signal.aborted || deadline.aborted) return { text: 'The download result could not be confirmed. Check Files before retrying.', failed: true, saved: false }
    return { text: `Downloaded ${body.bytes.byteLength} bytes to ${parsed.path}`, failed: false, saved: true }
}
