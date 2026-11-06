import { isAbsolute } from 'node:path'

/**
 * Directly launchable names. Images, documents, archives and `.bin` stay opaque bytes.
 * Nothing downloaded here is executed or unpacked.
 */
const EXECUTABLE_EXTENSIONS = new Set([
    'app', 'bat', 'bash', 'cmd', 'com', 'command', 'csh', 'dll', 'dylib', 'exe', 'fish', 'ksh', 'msi', 'ps1', 'scr', 'sh', 'so', 'zsh',
])

const EXECUTABLE_TYPES = new Set([
    'application/vnd.microsoft.portable-executable',
    'application/x-dosexec',
    'application/x-elf',
    'application/x-executable',
    'application/x-mach-binary',
    'application/x-msdos-program',
    'application/x-msdownload',
    'application/x-pie-executable',
    'application/x-sharedlib',
    'application/x-sh',
    'application/x-shellscript',
    'text/x-script',
    'text/x-shellscript',
])

export const EXECUTABLE_DOWNLOAD_MESSAGE = 'That file type can’t be downloaded.'
export const RESERVED_DOWNLOAD_MESSAGE = 'That path is reserved.'

const MAX_PATH = 4096
const MAX_SEGMENT = 255

/** `.rerun*` and `.rerun-skill*` at every depth, after NFKC case fold. Ordinary dotfiles stay. */
export function isReservedDownloadSegment(segment: string): boolean {
    const folded = segment.normalize('NFKC').toLowerCase()
    return folded.startsWith('.rerun') || folded.startsWith('.rerun-skill')
}

export function extensionOf(segment: string): string {
    const folded = segment.normalize('NFKC')
    const dot = folded.lastIndexOf('.')
    return dot <= 0 ? '' : folded.slice(dot + 1).toLowerCase()
}

export function isExecutableDownloadSegment(segment: string): boolean {
    return EXECUTABLE_EXTENSIONS.has(extensionOf(segment))
}

export function isExecutableContentType(value: string | null | undefined): boolean {
    if (!value) return false
    const mime = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    return EXECUTABLE_TYPES.has(mime)
}

function escape(path: string): Error {
    return new Error(`Path escapes the root: ${path}`)
}

/** Workspace-relative segments. Throws before any filesystem or network call. */
export function downloadPathParts(path: string): string[] {
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) throw escape(String(path))
    if (path.includes('\0') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path) || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw escape(path)
    const parts = path.split('/')
    if (parts.length === 0) throw escape(path)
    for (const part of parts) {
        const folded = part.normalize('NFKC')
        if (!part || !folded || folded === '.' || folded === '..' || folded.includes('/') || folded.includes('\\') || folded.length > MAX_SEGMENT) throw escape(path)
        if (isReservedDownloadSegment(part)) throw new Error(RESERVED_DOWNLOAD_MESSAGE)
        if (isExecutableDownloadSegment(part)) throw new Error(EXECUTABLE_DOWNLOAD_MESSAGE)
    }
    return parts
}
