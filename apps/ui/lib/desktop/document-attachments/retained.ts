'use client'
import { holdDraftAdmission } from '@/lib/desktop/draft-writes'
import { desktopDocumentKindForName, type DesktopDocumentAttachment, type DesktopDocumentScope } from '@rerun/contracts'
import { uploadDesktopDocument } from './client'

export type RetainedDocument = { scope: DesktopDocumentScope; id: string; file: File; position: number; attachment: DesktopDocumentAttachment | null; error: string | null; work: Promise<DesktopDocumentAttachment | null> | null; release: () => void }
const retained = new Map<string, RetainedDocument>(), listeners = new Set<(record: RetainedDocument) => void>()
export const documentScopeKey = (scope: DesktopDocumentScope) => JSON.stringify([scope.agentId, scope.tabUid, scope.sessionId ?? null])
export const retainedDocuments = (scope: DesktopDocumentScope) => [...retained.values()].filter(item => documentScopeKey(item.scope) === documentScopeKey(scope))
export const retainedDocument = (id: string) => retained.get(id)
export function forgetRetainedDocument(id: string) { const record = retained.get(id); if (record) { retained.delete(id); record.release() } }
export const canRetainDocuments = (files: readonly File[]) => retained.size + files.length <= 20 && [...retained.values()].reduce((sum, row) => sum + row.file.size, files.reduce((sum, file) => sum + file.size, 0)) <= 96 * 1024 * 1024
export const subscribeRetainedDocuments = (listener: (record: RetainedDocument) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const emit = (record: RetainedDocument) => { for (const listener of listeners) listener(record) }
export function documentPlaceholder(record: RetainedDocument): DesktopDocumentAttachment {
    const now = new Date().toISOString()
    return record.attachment ?? { attachmentId: record.id, scope: record.scope, name: record.file.name, mimeType: record.file.type || 'application/octet-stream', kind: desktopDocumentKindForName(record.file.name), byteLength: record.file.size, sha256: '0'.repeat(64), conversion: { mode: 'unsupported', state: record.error ? 'failed' : 'pending', ...(record.error ? { error: record.error } : {}) }, admitted: false, selected: true, position: record.position, uploaded: false, revision: record.id, createdAt: now, updatedAt: now }
}
export function retainDocument(scope: DesktopDocumentScope, file: File, position: number): RetainedDocument {
    if (retained.size >= 20 || [...retained.values()].reduce((sum, row) => sum + row.file.size, file.size) > 96 * 1024 * 1024) throw new Error('Save or remove pending attachments before adding more.')
    const record: RetainedDocument = { scope: { ...scope }, id: crypto.randomUUID(), file, position, attachment: null, error: null, work: null, release: holdDraftAdmission() }
    retained.set(record.id, record)
    return record
}
export function saveRetainedDocument(record: RetainedDocument): Promise<DesktopDocumentAttachment | null> {
    if (record.attachment) return Promise.resolve(record.attachment)
    if (record.work) return record.work
    const work = Promise.resolve().then(async () => {
        try {
            record.error = null; emit(record)
            const result = await uploadDesktopDocument(record.scope, record.id, record.file, AbortSignal.timeout(25_000), record.position)
            record.attachment = result; retained.delete(record.id); record.release()
            return result
        } catch (error) { record.error = error instanceof Error ? error.message : 'Upload did not finish. Retry the same file.'; return null }
        finally { record.work = null; emit(record) }
    })
    record.work = work; emit(record)
    return work
}
