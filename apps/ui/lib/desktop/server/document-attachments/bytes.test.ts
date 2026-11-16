import { describe, expect, it } from 'vitest'
import { desktopAudioTranscribable, inspectDesktopDocumentUpload } from './bytes'

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

    it('reads source, data and config names as model text only when the bytes are bounded UTF-8 text', () => {
        const text = (value: string) => new TextEncoder().encode(value)
        for (const name of ['script.py', 'app.ts', 'page.html', 'config.yaml', 'rows.tsv', 'query.sql', 'events.jsonl', 'Main.JAVA']) {
            // A browser names .ts a video and .html active content. Neither type is kept.
            const inspected = inspectDesktopDocumentUpload({ name, mimeType: name === 'app.ts' ? 'video/mp2t' : 'text/html' }, text('<script>alert(1)</script>\nline two\n'))
            expect(inspected).toMatchObject({ kind: 'text', mimeType: 'text/plain' })
        }
        // Not text after all: the same names keep the download-only binary rules, including the media-type refusal.
        expect(inspectDesktopDocumentUpload({ name: 'script.py', mimeType: 'application/octet-stream' }, binary).kind).toBe('binary')
        expect(inspectDesktopDocumentUpload({ name: 'script.py', mimeType: 'text/x-python' }, Uint8Array.from([0xff, 0xfe, 65])).kind).toBe('binary')
        expect(inspectDesktopDocumentUpload({ name: 'esc.sh', mimeType: 'text/x-sh' }, text('echo \u001b[31m')).kind).toBe('binary')
        expect(() => inspectDesktopDocumentUpload({ name: 'stream.ts', mimeType: 'video/mp2t' }, binary)).toThrow()
        expect(inspectDesktopDocumentUpload({ name: 'big.sql', mimeType: 'application/sql' }, text('x'.repeat(128 * 1024 + 1))).kind).toBe('binary')
        expect(inspectDesktopDocumentUpload({ name: 'blank.py', mimeType: 'text/x-python' }, text('  \n')).kind).toBe('binary')
        // Unlisted names and archives are untouched, and a record saved as binary is never reclassified.
        expect(inspectDesktopDocumentUpload({ name: 'notes.docx', mimeType: 'application/octet-stream' }, text('plain words')).kind).toBe('binary')
        expect(inspectDesktopDocumentUpload({ name: 'bundle.zip', mimeType: 'application/zip' }, text('plain words')).kind).toBe('binary')
        expect(inspectDesktopDocumentUpload({ name: 'script.py', mimeType: 'text/x-python', kind: 'binary' }, text('print(1)')).kind).toBe('binary')
        // The strict plain-text names keep refusing instead of falling back.
        expect(() => inspectDesktopDocumentUpload({ name: 'rows.csv', mimeType: 'text/csv' }, Uint8Array.from([0xff, 0xfe]))).toThrow()
    })

    it('offers every inspected audio format up to 8 MB to transcription, FLAC included', () => {
        for (const name of ['a.wav', 'a.mp3', 'a.m4a', 'a.ogg', 'a.flac', 'A.FLAC']) expect(desktopAudioTranscribable({ name, byteLength: 10 })).toBe(true)
        expect(desktopAudioTranscribable({ name: 'a.flac', byteLength: 8 * 1024 * 1024 + 1 })).toBe(false)
        expect(desktopAudioTranscribable({ name: 'a.flac', byteLength: 0 })).toBe(false)
        expect(desktopAudioTranscribable({ name: 'a.aiff', byteLength: 10 })).toBe(false)
        expect(desktopAudioTranscribable({ name: 'a.mp4', byteLength: 10 })).toBe(false)
    })
})
