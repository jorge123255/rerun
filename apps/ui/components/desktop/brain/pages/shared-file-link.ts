import type { SharedFileRef } from '@/components/brain/useSharedFilesTree'
import { invalidDir } from '@/lib/files/path-guards'

const MAX_PATH = 4096

// Same decode the file-link chip uses. A broken escape stays literal, matching `decodePath`.
function decodeLikeEditor(path: string): string {
    try {
        return decodeURI(path)
    } catch {
        return path
    }
}

// A second, stricter decode. `%2f` survives `decodeURI` and would become a slash later.
function decodeFully(path: string): string | null {
    try {
        return decodeURIComponent(path)
    } catch {
        return null
    }
}

function unsafeSharedPath(path: string): boolean {
    if (path.length === 0 || path.length > MAX_PATH) return true
    if (path !== path.trim() || /[\u0000-\u001f]/.test(path)) return true
    if (path.startsWith('/') || path.includes('\\') || /^[a-zA-Z]:/.test(path)) return true
    if (/^[a-z][a-z\d+.-]*:/i.test(path)) return true
    if (invalidDir(path)) return true
    return path.split('/').some(segment => {
        const trimmed = segment.trim()
        return trimmed.length === 0 || trimmed === '.' || trimmed === '..' || segment !== trimmed
    })
}

/**
 * A shared-file path this workspace has already listed, or null.
 * Missing, unsafe, and other-workspace targets are null. This does not look anything up.
 */
export function authorizedSharedFilePath(path: string, knownFiles: readonly Pick<SharedFileRef, 'path'>[]): string | null {
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH || path.includes('\0')) return null
    const candidate = decodeLikeEditor(path)
    if (unsafeSharedPath(candidate)) return null
    const loose = decodeFully(path)
    if (loose !== null && (loose !== candidate || unsafeSharedPath(loose))) return null
    const known = knownFiles.find(file => file.path === candidate)
    return known ? known.path : null
}

/** Listed files the page picker may cite. An unsafe listing is left out. */
export function linkableSharedFiles(knownFiles: readonly SharedFileRef[]): SharedFileRef[] {
    return knownFiles.filter(file => authorizedSharedFilePath(file.path, knownFiles) === file.path)
}
