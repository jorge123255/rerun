import { describe, expect, it } from 'vitest'
import { inspectDesktopDocumentUpload } from './bytes'

const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF')
const binary = Uint8Array.from([0, 1, 2, 255])

describe('document upload byte inspection', () => {
    it('freezes exact hash, kind and MIME evidence', () => {
        const first = inspectDesktopDocumentUpload({ name: 'report.pdf', mimeType: 'application/pdf' }, pdf)
        const second = inspectDesktopDocumentUpload({ name: 'report.pdf', mimeType: 'application/pdf' }, pdf)
        expect(first).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf', byteLength: pdf.byteLength, sha256: second.sha256 })
        expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(inspectDesktopDocumentUpload({ name: 'blob.bin', mimeType: 'application/octet-stream' }, binary).kind).toBe('binary')
    })

    it('rejects mismatched magic, path escapes and invalid metadata', () => {
        expect(() => inspectDesktopDocumentUpload({ name: 'report.pdf', mimeType: 'application/pdf' }, binary)).toThrow()
        expect(() => inspectDesktopDocumentUpload({ name: '../report.pdf', mimeType: 'application/pdf' }, pdf)).toThrow()
        expect(() => inspectDesktopDocumentUpload({ name: 'report.pdf', mimeType: 'text/plain' }, pdf)).toThrow()
        expect(() => inspectDesktopDocumentUpload({ name: 'report.pdf', mimeType: 'application/pdf' }, new Uint8Array())).toThrow()
    })
})
