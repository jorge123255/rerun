import { expect, test } from 'vitest'
import { DESKTOP_PDF_MAX_BYTES, DesktopPdfBytesError, desktopPdfKind, inspectDesktopPdfBytes } from './pdf-bytes'

function pdf(version = '1.4', body = '1 0 obj<<>>endobj\n') {
    return Buffer.from(`%PDF-${version}\n${body}%%EOF\n`)
}

function reason(bytes: Uint8Array) {
    try { inspectDesktopPdfBytes('pdf', bytes) }
    catch (error) { return error instanceof DesktopPdfBytesError ? error.reason : 'other' }
    return 'ok'
}

test('the PDF extension is case-insensitive and other extensions are refused', () => {
    expect(desktopPdfKind('deck.pdf')).toBe('pdf')
    expect(desktopPdfKind('Deck.PDF')).toBe('pdf')
    expect(desktopPdfKind('notes.md')).toBeNull()
    expect(desktopPdfKind('clip.mp4')).toBeNull()
})

test('accepts a PDF header of version 1.x or 2.0 with an EOF marker', () => {
    expect(inspectDesktopPdfBytes('pdf', pdf())).toEqual({ contentType: 'application/pdf' })
    expect(inspectDesktopPdfBytes('pdf', Buffer.from('%PDF-1.7%%EOF'))).toEqual({ contentType: 'application/pdf' })
    expect(inspectDesktopPdfBytes('pdf', pdf('2.0'))).toEqual({ contentType: 'application/pdf' })
})

test('refuses another format, an unsupported version, and a header without an EOF marker', () => {
    expect(reason(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBe('mismatch')
    expect(reason(Buffer.from('notes\n%PDF-1.4\n%%EOF\n'))).toBe('mismatch')
    expect(reason(pdf('3.0'))).toBe('unsupported')
    expect(reason(pdf('1.8'))).toBe('unsupported')
    expect(reason(pdf('2.1'))).toBe('unsupported')
    expect(reason(Buffer.from('%PDF-1.4\ntrailer'))).toBe('corrupt')
    expect(reason(Buffer.from('%PDF-'))).toBe('corrupt')
    expect(reason(Buffer.alloc(DESKTOP_PDF_MAX_BYTES + 1))).toBe('corrupt')
})
