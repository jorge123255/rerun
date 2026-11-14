import { fileExtension, filePreviewKind } from '@rerun/contracts'
import { ArchiveIcon, AudioWaveformIcon, BinaryIcon, Code2, FilmIcon, type LucideIcon } from '@/lib/icons'

export { fileExtension, filePreviewKind, type FilePreviewKind } from '@rerun/contracts'

const ARCHIVE_EXTS = new Set(['zip', 'gz', 'tar', 'rar', '7z', 'dmg', 'iso', 'jar'])
const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'json', 'yml', 'yaml', 'toml', 'html', 'css', 'scss'])

export function isArchive(name: string): boolean {
    return ARCHIVE_EXTS.has(fileExtension(name))
}

export function isCode(name: string): boolean {
    return CODE_EXTS.has(fileExtension(name))
}

// A thumbnail is worth at most one small request. Past these sizes the tile falls back to a
// typed glyph rather than pulling megabytes through the engine proxy for a 64px square.
export const THUMB_IMAGE_MAX_BYTES = 3_000_000
export const THUMB_TEXT_MAX_BYTES = 262_144

// The icon standing in for a file whose bytes are not worth rendering. `null` means the kind
// carries no icon of its own: an image shows itself, a pdf and a plain text file read as the
// default sheet.
export function fileTypeIcon(name: string): LucideIcon | null {
    switch (filePreviewKind(name)) {
        case 'audio':
            return AudioWaveformIcon
        case 'video':
            return FilmIcon
        case 'binary':
            return isArchive(name) ? ArchiveIcon : BinaryIcon
        case 'text':
            return isCode(name) ? Code2 : null
        default:
            return null
    }
}
