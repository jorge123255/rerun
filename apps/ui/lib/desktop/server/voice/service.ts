import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
    desktopVoiceRevisionActionSchema,
    desktopVoiceUploadSchema,
    type DesktopVoiceDraft,
    type DesktopVoiceScope,
} from '../../../../../../packages/contracts/src/desktop-voice.ts'
import { desktopVoiceAttemptFingerprint, buildDesktopVoiceMessage } from '../../voice/voice'
import { DesktopHttpError } from '../auth'
import { inspectDesktopVoiceBytes } from './bytes'
import type { DesktopVoiceAttemptRecord, DesktopVoiceAuthorities } from './types'

const uploadInputSchema = desktopVoiceUploadSchema.omit({ operation: true, audioBase64: true })
const revisionInputSchema = desktopVoiceRevisionActionSchema.omit({ operation: true })

type UploadInput = z.input<typeof uploadInputSchema>
type RevisionInput = z.input<typeof revisionInputSchema>

function changed(): DesktopHttpError {
    return new DesktopHttpError(409, 'This voice attempt changed. Reload it before retrying.')
}

function updated(record: DesktopVoiceAttemptRecord, patch: Partial<DesktopVoiceDraft>): DesktopVoiceAttemptRecord {
    return {
        ...record,
        draft: {
            ...record.draft,
            ...patch,
            revision: randomUUID(),
            updatedAt: new Date().toISOString(),
        },
    }
}

async function save(store: DesktopVoiceAuthorities['store'], record: DesktopVoiceAttemptRecord, patch: Partial<DesktopVoiceDraft>) {
    const next = updated(record, patch)
    await store.save(next, record.draft.revision)
    return next
}

export function createDesktopVoiceService(authorities: DesktopVoiceAuthorities) {
    const { store, blobs, owner, send, references } = authorities

    async function required(scope: DesktopVoiceScope, attemptId: string, expectedRevision?: string): Promise<DesktopVoiceAttemptRecord> {
        const record = await store.read(scope, attemptId)
        if (!record || (expectedRevision !== undefined && record.draft.revision !== expectedRevision)) throw changed()
        return record
    }

    async function readVerified(scope: DesktopVoiceScope, recording: DesktopVoiceAttemptRecord['draft']['recording'], signal: AbortSignal): Promise<Uint8Array> {
        const bytes = await blobs.read(scope, recording, signal)
        if (bytes.byteLength !== recording.byteLength || createHash('sha256').update(bytes).digest('hex') !== recording.sha256) throw new DesktopHttpError(409, 'Voice audio changed. Reload the message.')
        return bytes
    }

    return {
        async draft(scope: DesktopVoiceScope, attemptId: string, signal: AbortSignal): Promise<DesktopVoiceDraft | null> {
            await owner(scope, signal)
            const record = await store.read(scope, attemptId)
            if (!record) return null
            try {
                await readVerified(scope, record.draft.recording, signal)
                return record.draft
            } catch {
                return { ...record.draft, phase: 'failed', error: 'The saved voice bytes are unavailable. Record again; unacknowledged microphone chunks cannot be recovered.' }
            }
        },

        async list(scope: DesktopVoiceScope, signal: AbortSignal): Promise<DesktopVoiceDraft[]> {
            await owner(scope, signal)
            const records = await store.list(scope)
            const drafts: DesktopVoiceDraft[] = []
            for (const record of records) {
                try {
                    await readVerified(scope, record.draft.recording, signal)
                    drafts.push(record.draft)
                } catch {
                    drafts.push({ ...record.draft, phase: 'failed', error: 'The saved voice bytes are unavailable. Record again; unacknowledged microphone chunks cannot be recovered.' })
                }
            }
            return drafts
        },

        async upload(scope: DesktopVoiceScope, raw: UploadInput, bytes: Uint8Array, signal: AbortSignal): Promise<DesktopVoiceDraft> {
            await owner(scope, signal)
            const input = uploadInputSchema.parse(raw)
            if (input.agentId !== scope.agentId || input.tabUid !== scope.tabUid || input.sessionId !== scope.sessionId) throw changed()
            const inspected = inspectDesktopVoiceBytes(input.format, bytes, input)
            const recording = { attemptId: input.attemptId, ...inspected }
            const fingerprint = desktopVoiceAttemptFingerprint(scope, recording)
            const initial: DesktopVoiceAttemptRecord = {
                fingerprint,
                draft: {
                    attemptId: input.attemptId,
                    scope,
                    phase: 'uploading',
                    revision: randomUUID(),
                    recording,
                    transcript: null,
                    error: null,
                    messageId: null,
                    updatedAt: new Date().toISOString(),
                },
            }
            let reserved = await store.reserve(initial)
            if (reserved.record.fingerprint !== fingerprint) throw changed()
            try {
                signal.throwIfAborted()
                try {
                    await readVerified(scope, recording, signal)
                } catch {
                    await blobs.put(scope, recording, bytes, signal)
                }
                signal.throwIfAborted()
                if (reserved.record.draft.phase === 'sent' || reserved.record.draft.phase === 'ready') return reserved.record.draft
                reserved = await save(store, reserved.record, { phase: 'review', error: null })
                return reserved.draft
            } catch (error) {
                await save(store, reserved.record, { phase: 'failed', error: 'Voice upload did not complete. Retry the same recording.' })
                if (error instanceof DesktopHttpError) throw error
                throw new DesktopHttpError(500, 'Voice upload did not complete. Retry the same recording.')
            }
        },

        async transcribe(scope: DesktopVoiceScope, raw: RevisionInput, signal: AbortSignal): Promise<DesktopVoiceDraft> {
            await owner(scope, signal)
            const input = revisionInputSchema.parse(raw)
            let record = await required(scope, input.attemptId, input.expectedRevision)
            if (record.draft.transcript && record.draft.phase === 'ready') return record.draft
            if (!authorities.transcribe) {
                const unavailable = await save(store, record, { phase: 'unavailable', error: 'Transcription is not configured on this Mac. Your recording is still available for playback and download.' })
                return unavailable.draft
            }
            record = await save(store, record, { phase: 'transcribing', error: null })
            try {
                const bytes = await readVerified(scope, record.draft.recording, signal)
                signal.throwIfAborted()
                const transcript = (await authorities.transcribe({ bytes, format: record.draft.recording.transcriptionFormat, signal })).trim()
                signal.throwIfAborted()
                if (!transcript) return (await save(store, record, { phase: 'review', transcript: null, error: 'Couldn’t hear anything in that recording.' })).draft
                return (await save(store, record, { phase: 'ready', transcript, error: null })).draft
            } catch {
                await save(store, record, { phase: 'failed', error: 'Transcription failed. Retry the saved recording.' })
                throw new DesktopHttpError(502, 'Transcription failed. Retry the saved recording.')
            }
        },

        async send(scope: DesktopVoiceScope, raw: RevisionInput, signal: AbortSignal) {
            await owner(scope, signal)
            const input = revisionInputSchema.parse(raw)
            let record = await required(scope, input.attemptId, input.expectedRevision)
            const transcript = record.draft.transcript?.trim() ?? ''
            if (record.draft.phase === 'sent') return { draft: record.draft, text: buildDesktopVoiceMessage(scope, record.draft.recording, transcript) }
            if (!transcript) {
                return { draft: (await save(store, record, { phase: 'review', error: 'Transcribe this recording before sending.' })).draft, text: null }
            }
            const text = buildDesktopVoiceMessage(scope, record.draft.recording, transcript)
            record = await save(store, record, { phase: 'sending', error: null })
            try {
                signal.throwIfAborted()
                const receipt = await send({ scope, attemptId: input.attemptId, text, recording: record.draft.recording, signal })
                signal.throwIfAborted()
                const sent = await save(store, record, { phase: 'sent', messageId: receipt.messageId, error: null })
                return { draft: sent.draft, text }
            } catch {
                await save(store, record, { phase: 'ready', error: 'Voice message acknowledgement is unknown. Retry the same attempt.' })
                throw new DesktopHttpError(502, 'Voice message acknowledgement is unknown. Retry the same attempt.')
            }
        },

        async discard(scope: DesktopVoiceScope, raw: RevisionInput, signal: AbortSignal): Promise<void> {
            await owner(scope, signal)
            const input = revisionInputSchema.parse(raw)
            const record = await required(scope, input.attemptId, input.expectedRevision)
            if (record.draft.phase === 'sent' || await references(scope, input.attemptId)) throw new DesktopHttpError(409, 'This audio is referenced by a saved message, queue or another tab and cannot be removed.')
            signal.throwIfAborted()
            await blobs.delete(scope, record.draft.recording, signal)
            await store.discard(scope, input.attemptId)
        },

        async audio(scope: DesktopVoiceScope, attemptId: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
            await owner(scope, signal)
            const record = await required(scope, attemptId)
            const bytes = await readVerified(scope, record.draft.recording, signal)
            if (bytes.byteLength !== record.draft.recording.byteLength || createHash('sha256').update(bytes).digest('hex') !== record.draft.recording.sha256) throw new DesktopHttpError(409, 'Voice audio changed. Reload the message.')
            return { bytes, mimeType: record.draft.recording.mimeType }
        },
    }
}

export type DesktopVoiceService = ReturnType<typeof createDesktopVoiceService>
