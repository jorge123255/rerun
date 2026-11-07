import { MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'
import {
    FILES_IMPORT_ESCAPE,
    FILES_IMPORT_EXECUTABLE,
    FILES_IMPORT_RESERVED,
    FilesImportError,
} from './errors.js'

/**
 * Launchable names, same set the public-download packet refuses.
 * Original Files upload (`useFileUploads`) has no extension denylist.
 * Script source such as `.js` stays importable. Bytes are never executed.
 */
const EXECUTABLE_EXTENSIONS = new Set([
    'app', 'bat', 'bash', 'cmd', 'com', 'command', 'csh', 'dll', 'dylib', 'exe', 'fish', 'ksh', 'msi', 'ps1', 'scr', 'sh', 'so', 'zsh',
])

const MAX_PATH = 4096
const MAX_SEGMENT = 255

export { MAX_UPLOAD_FILE_BYTES as FILES_IMPORT_MAX_BYTES }

function escape(path: string): FilesImportError {
    return new FilesImportError(400, FILES_IMPORT_ESCAPE(path), 'unsafe_path')
}

/** Workspace-relative segments. Throws before any filesystem call. */
export function filesImportParts(path: string): string[] {
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) throw escape(String(path))
    if (path.includes('\0') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) throw escape(path)
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw escape(path)
    const parts = path.split('/')
    if (parts.length === 0) throw escape(path)
    for (const part of parts) {
        const folded = part.normalize('NFKC').toLowerCase()
        if (!part || !folded || folded === '.' || folded === '..' || folded.includes('/') || folded.includes('\\')) throw escape(path)
        if (new TextEncoder().encode(part).length > MAX_SEGMENT) throw escape(path)
        if (folded.startsWith('.rerun') || folded.startsWith('.rerun-skill') || folded.startsWith('internal.rerun')) {
            throw new FilesImportError(400, FILES_IMPORT_RESERVED, 'reserved')
        }
        const dot = folded.lastIndexOf('.')
        const ext = dot <= 0 ? '' : folded.slice(dot + 1)
        if (EXECUTABLE_EXTENSIONS.has(ext)) throw new FilesImportError(415, FILES_IMPORT_EXECUTABLE, 'executable')
    }
    return parts
}

export function filesImportTooLarge(byteLength: number): boolean {
    return !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_UPLOAD_FILE_BYTES
}
