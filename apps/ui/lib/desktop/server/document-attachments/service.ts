import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { desktopDocumentScopeSchema, desktopDocumentSelectionSchema, desktopDocumentRevisionActionSchema, desktopDocumentUploadSchema, DESKTOP_DOCUMENT_TEXT_MAX_CHARS, DESKTOP_DOCUMENT_INPUT_MAX_BYTES, type DesktopDocumentAdmission, type DesktopDocumentAttachment, type DesktopDocumentConversion, type DesktopDocumentReference, type DesktopDocumentScope, type DesktopDocumentSelection } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { inspectDesktopDocumentUpload, readDesktopPlainText } from './bytes'
import { documentConflict } from './store'
import type { DesktopDocumentAttachmentRecord, DesktopDocumentAuthorities } from './types'

const uploadSchema = desktopDocumentUploadSchema.omit({ audioBase64: true })
type Upload = typeof uploadSchema._input
type Revision = typeof desktopDocumentRevisionActionSchema._input
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const scopeKey = (scope: DesktopDocumentScope) => JSON.stringify([scope.agentId, scope.tabUid, scope.sessionId ?? null])
export function createDesktopDocumentAttachmentService(authorities: DesktopDocumentAuthorities) {
    const { store, blobs } = authorities
    const pending = new Map<string, Promise<void>>()
    async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
        const result = (pending.get(id) ?? Promise.resolve()).then(work)
        const tail = result.then(() => {}, () => {})
        pending.set(id, tail)
        void tail.then(() => { if (pending.get(id) === tail) pending.delete(id) })
        return result
    }
    async function owner(scope: DesktopDocumentScope, signal: AbortSignal) {
        desktopDocumentScopeSchema.parse(scope); signal.throwIfAborted()
        await authorities.owner(scope, signal); signal.throwIfAborted()
    }
    async function readOwner(scope: DesktopDocumentScope, id: string, signal: AbortSignal) {
        signal.throwIfAborted()
        if (authorities.readOwner) await authorities.readOwner(scope, id, signal)
        else await authorities.owner(scope, signal)
        signal.throwIfAborted()
    }
    async function required(scope: DesktopDocumentScope, id: string, revision?: string, allowDeleting = false) {
        const record = await store.read(scope, id)
        if (!record || !allowDeleting && record.deletion || scopeKey(record.attachment.scope) !== scopeKey(scope) || revision !== undefined && revision !== record.attachment.revision) throw documentConflict()
        return record
    }
    async function save(record: DesktopDocumentAttachmentRecord, patch: Partial<DesktopDocumentAttachment>) {
        const next = { ...record, attachment: { ...record.attachment, ...patch, revision: randomUUID(), updatedAt: new Date().toISOString() } }
        await store.save(next, record.attachment.revision)
        return next
    }
    async function verified(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, signal: AbortSignal) {
        signal.throwIfAborted()
        const bytes = await blobs.read(scope, attachment, signal)
        signal.throwIfAborted()
        if (bytes.byteLength !== attachment.byteLength || digest(bytes) !== attachment.sha256) throw documentConflict()
        inspectDesktopDocumentUpload(attachment, bytes)
        return bytes
    }
    const initialConversion = (kind: DesktopDocumentAttachment['kind']): DesktopDocumentConversion => kind === 'pdf'
        ? { mode: 'pdf-text', state: 'pending' }
        : kind === 'audio' ? { mode: 'voice-transcript', state: 'pending' }
            : { mode: 'unsupported', state: 'unsupported', error: 'This file can be downloaded, but this Mac app cannot send its contents to the selected model.' }
    async function scopes(scope: DesktopDocumentScope, signal: AbortSignal) {
        await owner(scope, signal)
        const result = authorities.readScopes ? await authorities.readScopes(scope, signal) : [scope]
        await owner(scope, signal)
        return result
    }
    const service = {
        upload(scope: DesktopDocumentScope, raw: Upload, bytes: Uint8Array, signal: AbortSignal): Promise<DesktopDocumentAttachment> {
            const input = uploadSchema.parse(raw)
            return exclusive(input.attachmentId, async () => {
                await owner(scope, signal)
                if (scopeKey(input) !== scopeKey(scope)) throw documentConflict()
                const inspected = inspectDesktopDocumentUpload(input, bytes)
                const fingerprint = digest(JSON.stringify([scopeKey(scope), input.attachmentId, input.name, inspected.mimeType, inspected.sha256, inspected.byteLength, input.position]))
                const now = new Date().toISOString()
                const conversion: DesktopDocumentConversion = inspected.kind === 'text'
                    ? { mode: 'plain-text', state: 'ready', text: readDesktopPlainText(bytes) }
                    : initialConversion(inspected.kind)
                const initial: DesktopDocumentAttachmentRecord = { fingerprint, attachment: { ...inspected, scope, attachmentId: input.attachmentId, name: input.name, position: input.position, uploaded: false, selected: true, admitted: false, conversion, revision: randomUUID(), createdAt: now, updatedAt: now } }
                await owner(scope, signal)
                let record = (await store.reserve(initial)).record
                if (record.fingerprint !== fingerprint || record.deletion) throw documentConflict()
                await owner(scope, signal)
                if (!record.attachment.uploaded) {
                    await blobs.put(scope, record.attachment, bytes, signal)
                    await owner(scope, signal)
                    record = await save(record, { uploaded: true })
                } else await verified(scope, record.attachment, signal)
                await owner(scope, signal)
                return record.attachment
            })
        },
        convert(scope: DesktopDocumentScope, raw: Revision, signal: AbortSignal): Promise<DesktopDocumentAttachment> {
            const input = desktopDocumentRevisionActionSchema.parse(raw)
            return exclusive(input.attachmentId, async () => {
                await owner(scope, signal)
                let record = await required(scope, input.attachmentId)
                if (record.attachment.conversion.state === 'ready') { await verified(scope, record.attachment, signal); await owner(scope, signal); return record.attachment }
                if (record.attachment.revision !== input.expectedRevision || !record.attachment.uploaded || record.attachment.admitted) throw documentConflict()
                const mode = initialConversion(record.attachment.kind).mode
                if (mode === 'unsupported') { await owner(scope, signal); return record.attachment }
                if (mode === 'pdf-text' && !authorities.extractPdfText) throw new DesktopHttpError(503, 'PDF text extraction is not configured on this Mac.')
                if (mode === 'voice-transcript' && (!authorities.transcribeAudio || !await authorities.transcriptionAvailable?.(record.attachment))) throw new DesktopHttpError(503, 'Audio preparation requires a configured transcription service and a supported audio file up to 8 MB.')
                const bytes = await verified(scope, record.attachment, signal)
                await owner(scope, signal)
                record = await save(record, { conversion: { mode, state: 'converting' } })
                try {
                    const text = (mode === 'pdf-text' ? await authorities.extractPdfText!(bytes, signal) : await authorities.transcribeAudio!({ bytes, mimeType: record.attachment.mimeType, name: record.attachment.name, signal })).trim()
                    await owner(scope, signal)
                    if (!text || text.length > DESKTOP_DOCUMENT_TEXT_MAX_CHARS) throw new DesktopHttpError(422, 'This document has no supported text, or its text is too large.')
                    record = await save(record, { conversion: { mode, state: 'ready', text } })
                    await owner(scope, signal)
                    return record.attachment
                } catch (error) {
                    // An interrupted conversion stays uncertain; restoring never restarts it.
                    if (!signal.aborted) {
                        await owner(scope, signal)
                        await save(record, { conversion: { mode, state: 'failed', error: 'Preparation did not finish. Retry explicitly to prepare this attachment again.' } }).catch(() => {})
                    }
                    throw error
                }
            })
        },
        async admission(scope: DesktopDocumentScope, raw: DesktopDocumentSelection, signal: AbortSignal): Promise<DesktopDocumentAdmission> {
            const selection = desktopDocumentSelectionSchema.parse(raw)
            await owner(scope, signal)
            const fingerprint = digest(JSON.stringify([scopeKey(scope), selection.attachmentIds, selection.modelChoice ?? null]))
            const previous = await store.readAdmission(scope, selection.admissionId)
            if (previous) {
                if (previous.fingerprint !== fingerprint) throw documentConflict()
                for (const ref of previous.admission.references) { await owner(ref.scope, signal); const item = await required(ref.scope, ref.attachmentId); await verified(ref.scope, item.attachment, signal); if (item.attachment.sha256 !== ref.sha256) throw documentConflict() }
                await owner(scope, signal)
                return previous.admission
            }
            const allowedScopes = await scopes(scope, signal)
            const records: DesktopDocumentAttachmentRecord[] = []
            const references: DesktopDocumentReference[] = [], inputs: DesktopDocumentAdmission['inputs'] = []
            let textBytes = 0
            for (const id of selection.attachmentIds) {
                let record: DesktopDocumentAttachmentRecord | null = null
                for (const candidate of allowedScopes) { record = await store.read(candidate, id); if (record) break }
                if (!record || record.deletion || !record.attachment.selected || !record.attachment.uploaded) throw documentConflict()
                const a = record.attachment
                await owner(a.scope, signal)
                await verified(a.scope, a, signal)
                if (a.conversion.state !== 'ready' || !a.conversion.text || !['pdf-text', 'voice-transcript', 'plain-text'].includes(a.conversion.mode)) return { allowed: false, reason: a.conversion.error ?? 'Prepare every selected attachment, or remove unsupported files before sending.', references: [], inputs: [] }
                textBytes += new TextEncoder().encode(a.conversion.text).byteLength
                if (textBytes > DESKTOP_DOCUMENT_INPUT_MAX_BYTES) return { allowed: false, reason: 'The selected documents contain more than 128 KiB of text. Choose fewer or shorter documents.', references: [], inputs: [] }
                references.push({ attachmentId: a.attachmentId, scope: a.scope, name: a.name, mimeType: a.mimeType, kind: a.kind, sha256: a.sha256, byteLength: a.byteLength })
                inputs.push({ mode: 'text', text: a.conversion.text })
                records.push(record)
            }
            await owner(scope, signal)
            const result = await store.admit({ scope, selection, fingerprint, admission: { allowed: true, admissionId: selection.admissionId, references, inputs } }, records)
            await owner(scope, signal)
            return result.admission
        },
        async consume(scope: DesktopDocumentScope, admissionId: string, signal: AbortSignal) { await owner(scope, signal); await store.consume(scope, admissionId); await owner(scope, signal) },
        cancelUpload(scope: DesktopDocumentScope, attachmentId: string, signal: AbortSignal) {
            return exclusive(attachmentId, async () => {
                await owner(scope, signal)
                const record = await store.read(scope, attachmentId)
                if (record?.attachment.uploaded) {
                    if (record.attachment.admitted) throw documentConflict()
                    if (await authorities.references(scope, attachmentId)) throw documentConflict()
                    await owner(scope, signal)
                    await store.reserveDiscard(scope, attachmentId, record.attachment.revision)
                    await blobs.delete(scope, record.attachment, signal)
                    await owner(scope, signal)
                    await store.discard(scope, attachmentId)
                } else {
                    await owner(scope, signal)
                    await store.cancelUpload(scope, attachmentId)
                }
                await owner(scope, signal)
            })
        },
        async list(scope: DesktopDocumentScope, signal: AbortSignal): Promise<DesktopDocumentAttachment[]> {
            const records = (await Promise.all((await scopes(scope, signal)).map(candidate => store.list(candidate)))).flat()
            const output: DesktopDocumentAttachment[] = []
            for (const record of records) {
                await owner(record.attachment.scope, signal)
                const a = record.attachment
                if (!a.uploaded) { output.push({ ...a, conversion: { ...a.conversion, state: 'failed', error: 'Upload is incomplete. Retry with the original file, or remove it and attach again.' } }); continue }
                try { await verified(a.scope, a, signal) }
                catch (error) { signal.throwIfAborted(); await owner(a.scope, signal); output.push({ ...a, conversion: { ...a.conversion, state: 'failed', error: 'Attachment bytes are unavailable. Remove it and attach the file again.' } }); continue }
                output.push(a.conversion.state === 'converting' && !pending.has(a.attachmentId) ? { ...a, conversion: { ...a.conversion, state: 'failed', error: 'Preparation was interrupted. Retry explicitly to prepare again.' } } : a)
            }
            await owner(scope, signal)
            return output.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.attachmentId.localeCompare(b.attachmentId))
        },
        detach(scope: DesktopDocumentScope, raw: Revision, signal: AbortSignal) {
            const input = desktopDocumentRevisionActionSchema.parse(raw)
            return exclusive(input.attachmentId, async () => { await owner(scope, signal); await required(scope, input.attachmentId, input.expectedRevision); await owner(scope, signal); await store.detach(scope, input.attachmentId, input.expectedRevision); await owner(scope, signal) })
        },
        discard(scope: DesktopDocumentScope, raw: Revision, signal: AbortSignal) {
            const input = desktopDocumentRevisionActionSchema.parse(raw)
            return exclusive(input.attachmentId, async () => {
                await owner(scope, signal)
                let record = await required(scope, input.attachmentId, input.expectedRevision, true)
                if (record.attachment.admitted || await authorities.references(scope, input.attachmentId)) throw new DesktopHttpError(409, 'This attachment is retained by a saved message. Remove it from the composer without deleting its bytes.')
                await owner(scope, signal)
                if (!record.deletion && record.attachment.conversion.state === 'converting') record = await save(record, { conversion: { ...record.attachment.conversion, state: 'failed' } })
                await store.reserveDiscard(scope, input.attachmentId, record.attachment.revision)
                await owner(scope, signal)
                await blobs.delete(scope, record.attachment, signal)
                await owner(scope, signal)
                await store.discard(scope, input.attachmentId)
            })
        },
        async read(scope: DesktopDocumentScope, attachmentId: string, sha256: string, signal: AbortSignal) {
            await readOwner(scope, attachmentId, signal)
            const record = await required(scope, attachmentId)
            if (!record.attachment.uploaded || record.attachment.sha256 !== sha256) throw documentConflict()
            const bytes = await verified(scope, record.attachment, signal)
            await readOwner(scope, attachmentId, signal)
            return { bytes, attachment: record.attachment }
        },
        async assertReadable(scope: DesktopDocumentScope, attachmentId: string, sha256: string, signal: AbortSignal) {
            await readOwner(scope, attachmentId, signal)
            const record = await required(scope, attachmentId)
            if (!record.attachment.uploaded || record.attachment.sha256 !== sha256) throw documentConflict()
            await readOwner(scope, attachmentId, signal)
        },
    }
    return service
}
export type DesktopDocumentAttachmentService = ReturnType<typeof createDesktopDocumentAttachmentService>
