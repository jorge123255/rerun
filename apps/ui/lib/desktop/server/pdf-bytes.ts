/** Structural checks for a desktop Files PDF preview.
 * A passing file starts with a PDF header of version 1.0–1.7 or 2.0 and contains an EOF marker.
 * Page contents are not parsed, so this does not prove the embedded viewer can display it. */

export const DESKTOP_PDF_MAX_BYTES = 16 * 1024 * 1024

export type DesktopPdfKind = 'pdf'
export type DesktopPdfContentType = 'application/pdf'

const CONTENT_TYPE: Record<DesktopPdfKind, DesktopPdfContentType> = { pdf: 'application/pdf' }
const EOF = [0x25, 0x25, 0x45, 0x4f, 0x46]

export class DesktopPdfBytesError extends Error {
    readonly reason: 'mismatch' | 'corrupt' | 'unsupported'
    constructor(reason: 'mismatch' | 'corrupt' | 'unsupported') {
        super(reason)
        this.name = 'DesktopPdfBytesError'
        this.reason = reason
    }
}

export function desktopPdfKind(name: string): DesktopPdfKind | null {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    return ext === 'pdf' ? 'pdf' : null
}

export function inspectDesktopPdfBytes(kind: DesktopPdfKind, bytes: Uint8Array): { contentType: DesktopPdfContentType } {
    if (kind !== 'pdf' || bytes.byteLength < 1 || bytes.byteLength > DESKTOP_PDF_MAX_BYTES) throw new DesktopPdfBytesError('corrupt')
    if (!startsWithPdfMarker(bytes)) throw new DesktopPdfBytesError('mismatch')
    if (bytes.byteLength < 8 || bytes[6] !== 0x2e || !isDigit(bytes[5]) || !isDigit(bytes[7])) throw new DesktopPdfBytesError('corrupt')
    const major = bytes[5]! - 0x30
    const minor = bytes[7]! - 0x30
    if (!((major === 1 && minor <= 7) || (major === 2 && minor === 0))) throw new DesktopPdfBytesError('unsupported')
    if (!hasEofMarker(bytes)) throw new DesktopPdfBytesError('corrupt')
    return { contentType: CONTENT_TYPE[kind] }
}

function startsWithPdfMarker(bytes: Uint8Array): boolean {
    return bytes.byteLength >= 5
        && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
}

function isDigit(value: number | undefined): boolean {
    return value !== undefined && value >= 0x30 && value <= 0x39
}

function hasEofMarker(bytes: Uint8Array): boolean {
    const end = bytes.byteLength - EOF.length
    for (let index = 8; index <= end; index += 1) {
        let match = true
        for (let mark = 0; mark < EOF.length; mark += 1) {
            if (bytes[index + mark] !== EOF[mark]) { match = false; break }
        }
        if (match) return true
    }
    return false
}
