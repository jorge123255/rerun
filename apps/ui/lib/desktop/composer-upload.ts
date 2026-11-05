import { DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_MAX_FILES, DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES } from '@rerun/contracts'

export type DesktopUploadStatus = 'queued' | 'importing' | 'error' | 'unresolved'

export type DesktopUploadItem = {
    id: string
    name: string
    size: number
    status: DesktopUploadStatus
    error: string | null
}

export type DesktopUploadRejection = { file: File; reason: string }

export type DesktopUploadPreflight = {
    accepted: File[]
    rejected: DesktopUploadRejection[]
    blockers: string[]
}

export type DesktopUploadImport =
    | { ok: true; path: string; name: string }
    | { ok: false; kind: 'rejected' | 'ambiguous'; message: string }

export const DESKTOP_UPLOAD_ACCEPT = '.txt,.md,text/plain,text/markdown'

const IMPORT_URL = (agentId: string) => `/api/desktop/agents/${encodeURIComponent(agentId)}/files`
const AMBIGUOUS_MESSAGE = 'The import result could not be confirmed. Check Files before attaching this file again.'

const parentFolder = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

// Mirrors the server's importFile name rules plus the attachment path rule, so a file that can
// never become a draft attachment is refused before its first request.
function uploadNameProblem(name: string): string | null {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.') || /\p{Cc}/u.test(name)) {
        return 'That file name can’t be imported.'
    }
    if (!/\.(?:txt|md)$/i.test(name)) return 'Only .txt and .md files can be attached.'
    return null
}

// Mirrors readCoworkerFile's attach checks: the draft save and the chat send refuse anything else,
// so a file that imports but cannot be attached would fail later with a worse message.
async function uploadContentProblem(file: File): Promise<string | null> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.some(byte => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) {
        return 'Attachments must contain UTF-8 text.'
    }
    try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
        return 'Attachments must contain UTF-8 text.'
    }
    return null
}

/**
 * Validates a whole picked batch against the shared attachment budget before any import runs:
 * the files already attached to the draft, the uploads still in flight, the per-file 32 KiB
 * limit, the 128 KiB aggregate and the 10-file cap all count. Existing sizes must be resolved
 * by the caller first — an unknown size is a blocker, never a guess.
 */
export async function preflightDesktopUploads(input: {
    files: readonly File[]
    attachedPaths: readonly string[]
    attachedSizes: ReadonlyMap<string, number | 'missing'>
    pending: readonly { size: number; status: DesktopUploadStatus }[]
}): Promise<DesktopUploadPreflight> {
    const blockers: string[] = []
    let attachedBytes = 0
    for (const path of input.attachedPaths) {
        const size = input.attachedSizes.get(path)
        if (size === 'missing') blockers.push('An attached file is no longer available. Remove it before adding files.')
        else if (typeof size !== 'number') blockers.push('Could not check the size of an attached file. Try again.')
        else attachedBytes += size
    }
    if (blockers.length) return { accepted: [], rejected: [], blockers }

    const reserved = input.pending.filter(item => item.status === 'queued' || item.status === 'importing')
    let slots = DESKTOP_ATTACHMENT_MAX_FILES - input.attachedPaths.length - reserved.length
    let bytesLeft = DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES - attachedBytes - reserved.reduce((sum, item) => sum + item.size, 0)

    const accepted: File[] = []
    const rejected: DesktopUploadRejection[] = []
    for (const file of input.files) {
        const nameProblem = uploadNameProblem(file.name)
        if (nameProblem) {
            rejected.push({ file, reason: nameProblem })
            continue
        }
        if (file.size > DESKTOP_ATTACHMENT_MAX_BYTES) {
            rejected.push({ file, reason: `Files can be up to ${DESKTOP_ATTACHMENT_MAX_BYTES / 1024} KiB.` })
            continue
        }
        if (slots <= 0) {
            rejected.push({ file, reason: `You can attach up to ${DESKTOP_ATTACHMENT_MAX_FILES} files.` })
            continue
        }
        if (file.size > bytesLeft) {
            rejected.push({ file, reason: `Attachments must be ${DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES / 1024} KiB or smaller in total.` })
            continue
        }
        const contentProblem = await uploadContentProblem(file)
        if (contentProblem) {
            rejected.push({ file, reason: contentProblem })
            continue
        }
        accepted.push(file)
        slots -= 1
        bytesLeft -= file.size
    }
    return { accepted, rejected, blockers }
}

type ListedEntry = { name: string; type: 'file' | 'dir'; size: number }

async function listDesktopFolder(agentId: string, folder: string, signal?: AbortSignal): Promise<ListedEntry[]> {
    const query = new URLSearchParams({ path: folder, hidden: '1' })
    const response = await fetch(`${IMPORT_URL(agentId)}?${query}`, { cache: 'no-store', signal })
    if (response.status === 404) return []
    const body = await response.json().catch(() => null)
    if (!response.ok || !Array.isArray(body?.entries)) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not check attached files.')
    return body.entries as ListedEntry[]
}

/**
 * Sizes of the workspace files a draft already points at, read through the same folder listing
 * the attachment picker uses. A path with no file entry is 'missing'; a failed listing throws so
 * the caller can refuse the batch instead of guessing.
 */
export async function desktopAttachmentSizes(agentId: string, paths: readonly string[], signal?: AbortSignal): Promise<Map<string, number | 'missing'>> {
    const sizes = new Map<string, number | 'missing'>()
    const parents = [...new Set(paths.map(parentFolder))]
    await Promise.all(parents.map(async folder => {
        const entries = await listDesktopFolder(agentId, folder, signal)
        for (const path of paths.filter(item => parentFolder(item) === folder)) {
            const entry = entries.find(item => item.name === path.slice(folder ? folder.length + 1 : 0) && item.type === 'file')
            sizes.set(path, entry && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : 'missing')
        }
    }))
    return sizes
}

/**
 * One create-only text import through the installed files route. The route never overwrites, so a
 * 4xx is a definitive refusal while anything else — a dropped connection, a 5xx, a success body we
 * cannot read — leaves the outcome genuinely unknown and reported as 'ambiguous', never retried
 * silently and never counted as an attachment.
 */
export async function importDesktopUpload(agentId: string, file: File, signal?: AbortSignal): Promise<DesktopUploadImport> {
    const form = new FormData()
    form.set('path', '')
    form.set('file', file)
    const response = await fetch(IMPORT_URL(agentId), { method: 'POST', body: form, signal })
    if (response.status === 201) {
        const body = await response.json().catch(() => null)
        if (body && typeof body.path === 'string' && typeof body.name === 'string') return { ok: true, path: body.path, name: body.name }
        return { ok: false, kind: 'ambiguous', message: AMBIGUOUS_MESSAGE }
    }
    if (response.status >= 400 && response.status < 500) {
        const body = await response.json().catch(() => null)
        return { ok: false, kind: 'rejected', message: typeof body?.error === 'string' && body.error ? body.error : `Could not import “${file.name}”.` }
    }
    return { ok: false, kind: 'ambiguous', message: AMBIGUOUS_MESSAGE }
}
