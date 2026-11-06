import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
    DESKTOP_DOCUMENT_MAX_FILES,
    DESKTOP_DOCUMENT_TEXT_MAX_CHARS,
    DESKTOP_DOCUMENT_TOTAL_MAX_BYTES,
    desktopDocumentRevisionActionSchema,
    desktopDocumentUploadSchema,
    type DesktopDocumentAdmission,
    type DesktopDocumentAttachment,
    type DesktopDocumentConversion,
    type DesktopDocumentReference,
    type DesktopDocumentScope,
} from '../../../../../../packages/contracts/src/desktop-document-attachments.ts'
import { DesktopHttpError } from '../auth'
import { inspectDesktopDocumentUpload } from './bytes'
import type { DesktopDocumentAttachmentRecord, DesktopDocumentAuthorities } from './types'

const uploadInputSchema = desktopDocumentUploadSchema.omit({ audioBase64: true })
const revisionInputSchema = desktopDocumentRevisionActionSchema
type UploadInput = z.input<typeof uploadInputSchema>
type RevisionInput = z.input<typeof revisionInputSchema>

function changed(): DesktopHttpError {
    return new DesktopHttpError(409, 'This attachment changed. Reload it before retrying.')
}

function updated(record: DesktopDocumentAttachmentRecord, patch: Partial<DesktopDocumentAttachment>): DesktopDocumentAttachmentRecord {
    return { ...record, attachment: { ...record.attachment, ...patch, revision: randomUUID(), updatedAt: new Date().toISOString() } }
}

async function save(store: DesktopDocumentAuthorities['store'], record: DesktopDocumentAttachmentRecord, patch: Partial<DesktopDocumentAttachment>) {
    const next = updated(record, patch)
    await store.save(next, record.attachment.revision)
    return next
}

export function createDesktopDocumentAttachmentService(authorities: DesktopDocumentAuthorities) {
    const { store, blobs, owner, references } = authorities

    async function required(scope: DesktopDocumentScope, attachmentId: string, expectedRevision?: string): Promise<DesktopDocumentAttachmentRecord> {
        const record = await store.read(scope, attachmentId)
        if (!record || (expectedRevision !== undefined && record.attachment.revision !== expectedRevision) || record.attachment.scope.agentId !== scope.agentId || record.attachment.scope.tabUid !== scope.tabUid || record.attachment.scope.sessionId !== scope.sessionId) throw changed()
        return record
    }

    async function readVerified(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, signal: AbortSignal): Promise<Uint8Array> {
        const bytes = await blobs.read(scope, attachment, signal)
        if (bytes.byteLength !== attachment.byteLength || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw changed()
        return bytes
    }

    function initialConversion(attachment: Pick<DesktopDocumentAttachment, 'kind' | 'mimeType'>): DesktopDocumentConversion {
        if (attachment.kind === 'pdf') return authorities.extractPdfText ? { mode: 'pdf-text', state: 'pending' } : { mode: 'unsupported', state: 'unsupported', error: 'PDF text extraction is not configured on this Mac.' }
        if (attachment.kind === 'audio') return authorities.transcribeAudio ? { mode: 'voice-transcript', state: 'pending' } : { mode: 'unsupported', state: 'unsupported', error: 'Audio transcription is not configured on this Mac.' }
        return authorities.stagedFileSupported(attachment.kind, attachment.mimeType) && authorities.stageFile
            ? { mode: 'staged-file', state: 'pending' }
            : { mode: 'unsupported', state: 'unsupported', error: 'This model does not support this file type. The attachment is available for download, but its contents are not sent to the model.' }
    }

    return {
        async upload(scope: DesktopDocumentScope, raw: UploadInput, bytes: Uint8Array, signal: AbortSignal): Promise<DesktopDocumentAttachment> {
            await owner(scope, signal)
            const input = uploadInputSchema.parse(raw)
            if (input.agentId !== scope.agentId || input.tabUid !== scope.tabUid || input.sessionId !== scope.sessionId) throw changed()
            const inspected = inspectDesktopDocumentUpload(input, bytes)
            const existing = await store.list(scope)
            if (existing.length >= DESKTOP_DOCUMENT_MAX_FILES || await store.bytesUsed(scope) + bytes.byteLength > DESKTOP_DOCUMENT_TOTAL_MAX_BYTES) throw new DesktopHttpError(413, 'Attachments can be up to 48 MB across ten files.')
            const now = new Date().toISOString()
            const base = {
                attachmentId: input.attachmentId,
                scope,
                name: input.name,
                ...inspected,
                admitted: false,
                revision: randomUUID(),
                createdAt: now,
                updatedAt: now,
            }
            const initial: DesktopDocumentAttachmentRecord = {
                fingerprint: JSON.stringify([scope, base]),
                attachment: { ...base, conversion: initialConversion(base) },
            }
            let reserved = await store.reserve(initial)
            if (reserved.record.fingerprint !== initial.fingerprint) throw changed()
            try {
                signal.throwIfAborted()
                if (reserved.created) await blobs.put(scope, reserved.record.attachment, bytes, signal)
                else {
                    try {
                        await readVerified(scope, reserved.record.attachment, signal)
                    } catch (error) {
                        if (error instanceof DesktopHttpError && error.status === 409) throw error
                        await blobs.put(scope, reserved.record.attachment, bytes, signal)
                    }
                }
                signal.throwIfAborted()
                return reserved.record.attachment
            } catch {
                await save(store, reserved.record, { conversion: { ...reserved.record.attachment.conversion, state: 'failed', error: 'Upload did not complete. Retry the same attachment.' } })
                throw new DesktopHttpError(500, 'Upload did not complete. Retry the same attachment.')
            }
        },

        async convert(scope: DesktopDocumentScope, raw: RevisionInput, signal: AbortSignal): Promise<DesktopDocumentAttachment> {
            await owner(scope, signal)
            const input = revisionInputSchema.parse(raw)
            let record = await required(scope, input.attachmentId, input.expectedRevision)
            const conversion = record.attachment.conversion
            if (conversion.state === 'ready' || conversion.state === 'unsupported') return record.attachment
            record = await save(store, record, { conversion: { ...conversion, state: 'converting', error: undefined } })
            try {
                const bytes = await readVerified(scope, record.attachment, signal)
                signal.throwIfAborted()
                if (conversion.mode === 'pdf-text') {
                    if (!authorities.extractPdfText) throw new Error('PDF text is unavailable')
                    const text = (await authorities.extractPdfText(bytes, signal)).trim()
                    if (!text || text.length > DESKTOP_DOCUMENT_TEXT_MAX_CHARS) throw new Error('PDF text is unavailable or too large')
                    return (await save(store, record, { conversion: { mode: conversion.mode, state: 'ready', text } })).attachment
                }
                if (conversion.mode === 'voice-transcript') {
                    if (!authorities.transcribeAudio) throw new Error('Audio transcription is unavailable')
                    const text = (await authorities.transcribeAudio({ bytes, mimeType: record.attachment.mimeType, signal })).trim()
                    if (!text || text.length > DESKTOP_DOCUMENT_TEXT_MAX_CHARS) throw new Error('Audio transcript is unavailable or too large')
                    return (await save(store, record, { conversion: { mode: conversion.mode, state: 'ready', text } })).attachment
                }
                if (conversion.mode === 'staged-file') {
                    if (!authorities.stageFile) throw new Error('File staging is unavailable')
                    const stagedRef = await authorities.stageFile(scope, record.attachment, bytes, signal)
                    return (await save(store, record, { conversion: { mode: conversion.mode, state: 'ready', stagedRef } })).attachment
                }
                throw new Error('Unsupported document conversion')
            } catch (error) {
                await save(store, record, { conversion: { ...record.attachment.conversion, state: 'failed', error: 'Document conversion failed. Retry the same attachment.' } })
                if (error instanceof DesktopHttpError) throw error
                throw new DesktopHttpError(502, 'Document conversion failed. Retry the same attachment.')
            }
        },

        async admission(scope: DesktopDocumentScope, signal: AbortSignal): Promise<DesktopDocumentAdmission> {
            await owner(scope, signal)
            const records = await store.list(scope)
            const references: DesktopDocumentReference[] = []
            const inputs: DesktopDocumentAdmission['inputs'] = []
            for (const record of records) {
                const { attachment } = record
                const { conversion } = attachment
                if (conversion.state !== 'ready') {
                    return { allowed: false, reason: conversion.error ?? 'Wait for every attachment to finish converting, or remove the unsupported attachment before sending.', references: [], inputs: [] }
                }
                const reference = { attachmentId: attachment.attachmentId, name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind, sha256: attachment.sha256 }
                references.push(reference)
                if (conversion.mode === 'staged-file') {
                    if (!conversion.stagedRef) return { allowed: false, reason: 'An attachment has no supported model input.', references: [], inputs: [] }
                    inputs.push({ mode: 'file', reference })
                } else if (conversion.text) inputs.push({ mode: 'text', text: conversion.text })
                else return { allowed: false, reason: 'An attachment has no supported model input.', references: [], inputs: [] }
            }
            for (const record of records) {
                if (!record.attachment.admitted) record.attachment = (await save(store, record, { admitted: true })).attachment
            }
            return { allowed: true, references, inputs }
        },

        async list(scope: DesktopDocumentScope, signal: AbortSignal): Promise<DesktopDocumentAttachment[]> {
            await owner(scope, signal)
            const records = await store.list(scope)
            const attachments: DesktopDocumentAttachment[] = []
            for (const record of records) {
                try {
                    await readVerified(scope, record.attachment, signal)
                    attachments.push(record.attachment)
                } catch {
                    attachments.push({ ...record.attachment, conversion: { ...record.attachment.conversion, state: 'failed', error: 'Attachment bytes are unavailable or changed. Attach the file again.' } })
                }
            }
            return attachments
        },

        async discard(scope: DesktopDocumentScope, raw: RevisionInput, signal: AbortSignal): Promise<void> {
            await owner(scope, signal)
            const input = revisionInputSchema.parse(raw)
            const record = await required(scope, input.attachmentId, input.expectedRevision)
            if (record.attachment.admitted || await references(scope, input.attachmentId)) throw new DesktopHttpError(409, 'This attachment is referenced by a saved message, queue or another tab and cannot be removed.')
            signal.throwIfAborted()
            await blobs.delete(scope, record.attachment, signal)
            await store.discard(scope, input.attachmentId)
        },

        async read(scope: DesktopDocumentScope, attachmentId: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
            await owner(scope, signal)
            const record = await required(scope, attachmentId)
            return { bytes: await readVerified(scope, record.attachment, signal), mimeType: record.attachment.mimeType }
        },
    }
}

export type DesktopDocumentAttachmentService = ReturnType<typeof createDesktopDocumentAttachmentService>
