'use client'
import { holdDraftAdmission } from '@/lib/desktop/draft-writes'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES, desktopDocumentKindForName, documentScopeKey, type DesktopDocumentAttachment, type DesktopDocumentScope } from '@rerun/contracts'
import { uploadDesktopDocument } from './client'
import { desktopDocumentTimeoutMs } from './plan-document-add'

/** `progress` is the sent share of a large file (0 to 1) while it uploads, otherwise null. */
export type RetainedDocument = { scope: DesktopDocumentScope; id: string; file: File; position: number; progress: number | null; attachment: DesktopDocumentAttachment | null; error: string | null; work: Promise<DesktopDocumentAttachment | null> | null; release: () => void }
const retained = new Map<string, RetainedDocument>(), listeners = new Set<(record: RetainedDocument) => void>()
export const retainedDocuments = (scope: DesktopDocumentScope) => [...retained.values()].filter(item => documentScopeKey(item.scope) === documentScopeKey(scope))
export const retainedDocument = (id: string) => retained.get(id)
export function forgetRetainedDocument(id: string) { const record = retained.get(id); if (record) { retained.delete(id); record.release() } }
// A small file is read into memory to be sent, so those waiting are bounded together. A large one
// is streamed from disk by the browser and only counts against the large-file allowance.
const SMALL_RETAINED_BYTES = 96 * 1024 * 1024, LARGE_RETAINED_BYTES = 2 * DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES
const retainedBytes = (files: readonly { size: number }[], large: boolean) => files.reduce((sum, file) => sum + (file.size > DESKTOP_DOCUMENT_MAX_BYTES === large ? file.size : 0), 0)
export const canRetainDocuments = (files: readonly File[]) => {
    const all = [...[...retained.values()].map(row => row.file), ...files]
    return all.length <= 20 && retainedBytes(all, false) <= SMALL_RETAINED_BYTES && retainedBytes(all, true) <= LARGE_RETAINED_BYTES
}
export const subscribeRetainedDocuments = (listener: (record: RetainedDocument) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const emit = (record: RetainedDocument) => { for (const listener of listeners) listener(record) }
export function documentPlaceholder(record: RetainedDocument): DesktopDocumentAttachment {
    const now = new Date().toISOString()
    return record.attachment ?? { attachmentId: record.id, scope: record.scope, name: record.file.name, mimeType: record.file.type || 'application/octet-stream', kind: desktopDocumentKindForName(record.file.name), byteLength: record.file.size, sha256: '0'.repeat(64), conversion: { mode: 'unsupported', state: record.error ? 'failed' : 'pending', ...(record.error ? { error: record.error } : {}) }, admitted: false, selected: true, position: record.position, uploaded: false, revision: record.id, createdAt: now, updatedAt: now }
}
export function retainDocument(scope: DesktopDocumentScope, file: File, position: number): RetainedDocument {
    if (!canRetainDocuments([file])) throw new Error('Save or remove pending attachments before adding more.')
    const record: RetainedDocument = { scope: { ...scope }, id: crypto.randomUUID(), file, position, progress: null, attachment: null, error: null, work: null, release: holdDraftAdmission() }
    retained.set(record.id, record)
    return record
}
export function saveRetainedDocument(record: RetainedDocument): Promise<DesktopDocumentAttachment | null> {
    if (record.attachment) return Promise.resolve(record.attachment)
    if (record.work) return record.work
    const work = Promise.resolve().then(async () => {
        try {
            record.error = null; emit(record)
            const result = await uploadDesktopDocument(record.scope, record.id, record.file, AbortSignal.timeout(desktopDocumentTimeoutMs(record.file)), record.position, fraction => {
                // One update per whole percent keeps a 100 MB upload to a hundred repaints.
                const next = Math.floor(fraction * 100) / 100
                if (next !== record.progress) { record.progress = next; emit(record) }
            })
            record.attachment = result; retained.delete(record.id); record.release()
            return result
        } catch (error) { record.error = error instanceof Error ? error.message : 'Upload did not finish. Retry the same file.'; return null }
        finally { record.work = null; record.progress = null; emit(record) }
    })
    record.work = work; emit(record)
    return work
}
