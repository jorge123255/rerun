import { MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'

/**
 * Client copy of `apps/engine/src/desktop/files-import/paths.ts`.
 * Refuses before the writer runs. The publisher checks again.
 * Original `useFileUploads` only rejects size; desktop also refuses escape,
 * `internal.rerun*` / `.rerun*` / `.rerun-skill*` aliases, and launchable names.
 */
const EXECUTABLE_EXTENSIONS = new Set([
    'app', 'bat', 'bash', 'cmd', 'com', 'command', 'csh', 'dll', 'dylib', 'exe', 'fish', 'ksh', 'msi', 'ps1', 'scr', 'sh', 'so', 'zsh',
])

const MAX_PATH = 4096
const MAX_SEGMENT = 255

export const FILES_IMPORT_ESCAPE = (path: string) => `Path escapes the root: ${path}`
export const FILES_IMPORT_RESERVED = 'That path is reserved.'
export const FILES_IMPORT_EXECUTABLE = 'That file type can’t be imported.'

export type FilesImportPathCode = 'unsafe_path' | 'reserved' | 'executable'

export type FilesImportPathAdmission =
    | { ok: true; parts: string[] }
    | { ok: false; code: FilesImportPathCode; message: string }

export function admitFilesImportPath(path: string): FilesImportPathAdmission {
    const fail = (code: FilesImportPathCode, message: string): FilesImportPathAdmission => ({ ok: false, code, message })
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) return fail('unsafe_path', FILES_IMPORT_ESCAPE(String(path)))
    if (path.includes('\0') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return fail('unsafe_path', FILES_IMPORT_ESCAPE(path))
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return fail('unsafe_path', FILES_IMPORT_ESCAPE(path))
    const parts = path.split('/')
    if (parts.length === 0) return fail('unsafe_path', FILES_IMPORT_ESCAPE(path))
    for (const part of parts) {
        const folded = part.normalize('NFKC').toLowerCase()
        if (!part || !folded || folded === '.' || folded === '..' || folded.includes('/') || folded.includes('\\')) return fail('unsafe_path', FILES_IMPORT_ESCAPE(path))
        if (new TextEncoder().encode(part).length > MAX_SEGMENT) return fail('unsafe_path', FILES_IMPORT_ESCAPE(path))
        if (folded.startsWith('.rerun') || folded.startsWith('.rerun-skill') || folded.startsWith('internal.rerun')) return fail('reserved', FILES_IMPORT_RESERVED)
        const dot = folded.lastIndexOf('.')
        const ext = dot <= 0 ? '' : folded.slice(dot + 1)
        if (EXECUTABLE_EXTENSIONS.has(ext)) return fail('executable', FILES_IMPORT_EXECUTABLE)
    }
    return { ok: true, parts }
}

export function filesImportTooLarge(byteLength: number): boolean {
    return !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_UPLOAD_FILE_BYTES
}

export { MAX_UPLOAD_FILE_BYTES as FILES_IMPORT_MAX_BYTES }
