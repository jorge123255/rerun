import { fileExtension, filePreviewKind, THUMB_IMAGE_MAX_BYTES, THUMB_TEXT_MAX_BYTES } from '@/lib/files/preview'

/** First lines the original file head keeps for a sheet thumbnail. */
export const DESKTOP_FILES_TEXT_HEAD_CHARS = 600

/** Same sentence as the coworker Files empty row. */
export const DESKTOP_FILES_EMPTY_LABEL = 'This is your coworker’s workspace. Files it downloads, creates or edits during its runs are stored here.'

const RESERVED_PREFIXES = ['internal.rerun', '.rerun-skill']

export type DesktopFilesGridEntry = {
    name: string
    type: 'file' | 'dir'
    size: number
    identity?: string
}

/** Reserved aliases stay out of the grid. Ordinary hidden names such as `.env` stay. */
export function isReservedDesktopFilesName(name: string): boolean {
    const base = name.split('/').pop() ?? name
    const folded = base.toLowerCase()
    return RESERVED_PREFIXES.some(prefix => folded.startsWith(prefix))
}

export function desktopFilesChildPath(currentPath: string, name: string): string {
    return currentPath ? `${currentPath}/${name}` : name
}

export function desktopFilesWantsTextThumb(entry: DesktopFilesGridEntry): boolean {
    if (entry.type !== 'file') return false
    if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > THUMB_TEXT_MAX_BYTES) return false
    return filePreviewKind(entry.name) === 'text'
}

/**
 * Same-origin Files image route for a thumbnail, or null when the tile must stay a glyph.
 * Does not fetch. A later refusal is the image element's error, not a successful thumb.
 */
export function desktopFilesImageThumbUrl(filesBase: string, path: string, identity: string | undefined, size: number): string | null {
    if (!filesBase.startsWith('/api/desktop/agents/') || !filesBase.endsWith('/files') || filesBase.includes('?') || filesBase.includes('#')) return null
    const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
    if (!name || name.includes('\\') || name.includes('\0') || filePreviewKind(name) !== 'image') return null
    if (!Number.isSafeInteger(size) || size < 1 || size > THUMB_IMAGE_MAX_BYTES) return null
    const params = new URLSearchParams({ path })
    if (identity) params.set('identity', identity)
    return `${filesBase}/image?${params.toString()}`
}

/** Slice a Files read body for a sheet. Refusal, conflict, and non-text are an empty head. */
export function desktopFilesTextHead(body: unknown, ok: boolean): string {
    if (!ok || !body || typeof body !== 'object') return ''
    const record = body as { content?: unknown; error?: unknown; conflict?: unknown }
    if (record.conflict || record.error || typeof record.content !== 'string') return ''
    return record.content.slice(0, DESKTOP_FILES_TEXT_HEAD_CHARS)
}

export function desktopFilesExtensionBadge(name: string): string | undefined {
    return fileExtension(name) || undefined
}
