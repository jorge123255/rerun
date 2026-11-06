import { describe, expect, it, vi } from 'vitest'
import { createDesktopDocumentAttachmentService } from './service'
import type { DesktopDocumentAttachmentRecord, DesktopDocumentBlobStore, DesktopDocumentStore } from './types'
import type { DesktopDocumentScope } from '../../../../../../packages/contracts/src/desktop-document-attachments.ts'

const scope: DesktopDocumentScope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'session-1' }
const attemptId = '11111111-1111-4111-8111-111111111111'
const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF')
const input = { ...scope, attachmentId: attemptId, name: 'report.pdf', mimeType: 'application/pdf' }

function fixture(options: { extract?: (bytes: Uint8Array) => Promise<string>; staged?: boolean; referenced?: boolean } = {}) {
    const records = new Map<string, DesktopDocumentAttachmentRecord>()
    const clone = <T,>(value: T): T => structuredClone(value)
    const store: DesktopDocumentStore = {
        async reserve(record) {
            const existing = records.get(record.attachment.attachmentId)
            if (existing) return { record: clone(existing), created: false }
            records.set(record.attachment.attachmentId, clone(record))
            return { record: clone(record), created: true }
        },
        async read(_scope, attachmentId) { return clone(records.get(attachmentId) ?? null) },
        async list() { return clone([...records.values()]) },
        async save(record, expectedRevision) {
            if (records.get(record.attachment.attachmentId)?.attachment.revision !== expectedRevision) throw new Error('revision conflict')
            records.set(record.attachment.attachmentId, clone(record))
        },
        async discard(_scope, attachmentId) { records.delete(attachmentId) },
        async bytesUsed() { return pdf.byteLength },
    }
    const blobs = new Map<string, Uint8Array>()
    const put = vi.fn(async (_scope: DesktopDocumentScope, attachment: DesktopDocumentAttachmentRecord['attachment'], bytes: Uint8Array) => { blobs.set(attachment.attachmentId, bytes) })
    const blobStore: DesktopDocumentBlobStore = {
        put,
        async read(_scope, attachment) {
            const value = blobs.get(attachment.attachmentId)
            if (!value) throw new Error('missing')
            return value
        },
        async delete(_scope, attachment) { blobs.delete(attachment.attachmentId) },
    }
    const extract = vi.fn(async (_bytes: Uint8Array) => options.extract ? options.extract(_bytes) : 'Recognized PDF text')
    const stagedFileSupported = vi.fn(() => options.staged ?? false)
    const references = vi.fn(async () => options.referenced ?? false)
    const owner = vi.fn(async () => {})
    const service = createDesktopDocumentAttachmentService({ store, blobs: blobStore, owner, references, extractPdfText: extract, stagedFileSupported })
    return { service, records, blobs, put, extract, references, owner, stagedFileSupported }
}

describe('document attachment lifecycle', () => {
    it('deduplicates immutable upload, extracts PDF text and preserves ordered admission', async () => {
        const f = fixture({ staged: true })
        const first = await f.service.upload(scope, input, pdf, new AbortController().signal)
        await f.service.upload(scope, input, pdf, new AbortController().signal)
        expect(f.put).toHaveBeenCalledTimes(1)
        const ready = await f.service.convert(scope, { attachmentId: attemptId, expectedRevision: first.revision }, new AbortController().signal)
        expect(ready.conversion).toMatchObject({ mode: 'pdf-text', state: 'ready', text: 'Recognized PDF text' })
        const admission = await f.service.admission(scope, new AbortController().signal)
        expect(admission).toMatchObject({ allowed: true, inputs: [{ mode: 'text', text: 'Recognized PDF text' }] })
        expect(admission.references.map(reference => reference.name)).toEqual(['report.pdf'])
        await expect(f.service.upload(scope, input, new TextEncoder().encode('%PDF-1.4\n%%EOF'), new AbortController().signal)).rejects.toThrow()
        expect(f.put).toHaveBeenCalledTimes(1)
    })

    it('explains unsupported model/file combinations without claiming the model read the file', async () => {
        const f = fixture({ staged: false })
        const uploaded = await f.service.upload(scope, { ...input, name: 'blob.bin', mimeType: 'application/octet-stream' }, pdf, new AbortController().signal)
        const admission = await f.service.admission(scope, new AbortController().signal)
        expect(admission.allowed).toBe(false)
        expect(admission.reason).toContain('not supported')
        expect(uploaded.conversion.state).toBe('unsupported')
    })

    it('retains bytes after conversion failure and restores without replaying conversion work', async () => {
        const f = fixture({ extract: async () => { throw new Error('conversion failed') } })
        const uploaded = await f.service.upload(scope, input, pdf, new AbortController().signal)
        await expect(f.service.convert(scope, { attachmentId: attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)).rejects.toThrow('conversion failed')
        expect(f.extract).toHaveBeenCalledTimes(1)
        const restored = await f.service.list(scope, new AbortController().signal)
        expect(restored[0]!.conversion.state).toBe('failed')
        expect(f.extract).toHaveBeenCalledTimes(1)
        const failed = await f.service.admission(scope, new AbortController().signal)
        expect(failed.allowed).toBe(false)
    })

    it('refuses referenced cleanup and removes only exact unreferenced owned staging', async () => {
        const referenced = fixture({ referenced: true })
        const uploaded = await referenced.service.upload(scope, input, pdf, new AbortController().signal)
        await expect(referenced.service.discard(scope, { attachmentId: attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)).rejects.toThrow('referenced')
        expect(referenced.blobs.has(attemptId)).toBe(true)

        const f = fixture()
        const uploaded = await f.service.upload(scope, input, pdf, new AbortController().signal)
        await f.service.discard(scope, { attachmentId: attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)
        expect(f.blobs.has(attemptId)).toBe(false)
    })

    it('validates current owner before reads and mutations', async () => {
        const f = fixture()
        await f.service.upload(scope, input, pdf, new AbortController().signal)
        expect(f.owner).toHaveBeenCalled()
        expect(f.owner.mock.calls.every(call => call[0] === scope)).toBe(true)
    })
})
