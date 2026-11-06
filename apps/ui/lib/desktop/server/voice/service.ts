import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
    desktopVoiceRevisionActionSchema,
    desktopVoiceUploadSchema,
    type DesktopVoiceDraft,
    type DesktopVoiceScope,
    type DesktopVoiceSendReceipt,
} from '@rerun/contracts'
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
            ...(record.sendChoice === undefined ? {} : { sendModelChoice: record.sendChoice }),
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
    const active = new Map<string, Promise<unknown>>()
    const exclusive = <T>(scope: DesktopVoiceScope, attemptId: string, work: () => Promise<T>): Promise<T> => {
        const key = JSON.stringify([scope.agentId, scope.tabUid, scope.sessionId, attemptId])
        const next = (active.get(key) ?? Promise.resolve()).then(work, work)
        active.set(key, next)
        const clear = () => { if (active.get(key) === next) active.delete(key) }
        void next.then(clear, clear)
        return next
    }
    const check = async (scope: DesktopVoiceScope, signal: AbortSignal) => {
        signal.throwIfAborted()
        await owner(scope, signal)
        signal.throwIfAborted()
    }
    const persist = async (scope: DesktopVoiceScope, record: DesktopVoiceAttemptRecord, patch: Partial<DesktopVoiceDraft>, signal: AbortSignal) => {
        await check(scope, signal)
        const next = await save(store, record, patch)
        await check(scope, signal)
        return next
    }
    const scopeMatches = (left: DesktopVoiceScope, right: DesktopVoiceScope) => left.agentId === right.agentId && left.tabUid === right.tabUid && left.sessionId === right.sessionId
    const action = (scope: DesktopVoiceScope, raw: RevisionInput) => {
        const input = revisionInputSchema.parse(raw)
        if (!scopeMatches(scope, input)) throw changed()
        return input
    }

    async function required(scope: DesktopVoiceScope, attemptId: string, expectedRevision?: string): Promise<DesktopVoiceAttemptRecord> {
        const record = await store.read(scope, attemptId)
        if (!record || record.deletion || !scopeMatches(scope, record.draft.scope) || (expectedRevision !== undefined && record.draft.revision !== expectedRevision)) throw changed()
        return record
    }

    async function readVerified(scope: DesktopVoiceScope, recording: DesktopVoiceAttemptRecord['draft']['recording'], signal: AbortSignal, authorize = () => check(scope, signal)): Promise<Uint8Array> {
        await authorize()
        const bytes = await blobs.read(scope, recording, signal)
        await authorize()
        if (bytes.byteLength !== recording.byteLength || createHash('sha256').update(bytes).digest('hex') !== recording.sha256) throw new DesktopHttpError(409, 'Voice audio changed. Reload the message.')
        return bytes
    }

    return {
        async draft(scope: DesktopVoiceScope, attemptId: string, signal: AbortSignal): Promise<DesktopVoiceDraft | null> {
            await check(scope, signal)
            const scopes = authorities.readScopes ? await authorities.readScopes(scope, signal) : [scope]
            let record: DesktopVoiceAttemptRecord | null = null
            for (const candidate of scopes) {
                record = await store.read(candidate, attemptId)
                if (record) {
                    if (!scopeMatches(candidate, record.draft.scope)) throw changed()
                    break
                }
            }
            await check(scope, signal)
            if (!record || record.deletion === 'complete') return null
            if (record.deletion) return record.draft
            try {
                await readVerified(record.draft.scope, record.draft.recording, signal)
                await check(scope, signal)
                return record.draft
            } catch {
                await check(scope, signal)
                return { ...record.draft, phase: 'failed', error: 'The saved voice bytes are unavailable. Record again; unacknowledged microphone chunks cannot be recovered.' }
            }
        },

        async list(scope: DesktopVoiceScope, signal: AbortSignal): Promise<DesktopVoiceDraft[]> {
            await check(scope, signal)
            const scopes = authorities.readScopes ? await authorities.readScopes(scope, signal) : [scope]
            const records: DesktopVoiceAttemptRecord[] = []
            for (const candidate of scopes) {
                const values = await store.list(candidate)
                if (values.some(record => !scopeMatches(record.draft.scope, candidate))) throw changed()
                records.push(...values)
            }
            const drafts: DesktopVoiceDraft[] = []
            for (const record of records) {
                await check(scope, signal)
                if (record.deletion === 'complete' || record.draft.phase === 'sent') continue
                if (record.deletion) { drafts.push(record.draft); continue }
                try {
                    await readVerified(record.draft.scope, record.draft.recording, signal)
                    drafts.push(record.draft)
                } catch {
                    await check(scope, signal)
                    drafts.push({ ...record.draft, phase: 'failed', error: 'The saved voice bytes are unavailable. Record again; unacknowledged microphone chunks cannot be recovered.' })
                }
            }
            await check(scope, signal)
            return drafts
        },

        async upload(scope: DesktopVoiceScope, raw: UploadInput, bytes: Uint8Array, signal: AbortSignal): Promise<DesktopVoiceDraft> {
            const input = uploadInputSchema.parse(raw)
            if (input.agentId !== scope.agentId || input.tabUid !== scope.tabUid || input.sessionId !== scope.sessionId) throw changed()
            const inspected = inspectDesktopVoiceBytes(input.format, bytes, input)
            const recording = { attemptId: input.attemptId, ...inspected }
            const fingerprint = desktopVoiceAttemptFingerprint(scope, recording)
            return exclusive(scope, input.attemptId, async () => {
                await check(scope, signal)
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
                const reserved = await store.reserve(initial)
                await check(scope, signal)
                if (reserved.record.fingerprint !== fingerprint || reserved.record.deletion || !scopeMatches(scope, reserved.record.draft.scope)) throw changed()
                let record = reserved.record
                if (record.draft.phase !== 'uploading' && record.draft.phase !== 'failed') {
                    await readVerified(scope, recording, signal)
                    return record.draft
                }
                if (record.draft.phase === 'failed') record = await persist(scope, record, { phase: 'uploading', error: null }, signal)
                try {
                    try {
                        await readVerified(scope, recording, signal)
                    } catch {
                        await check(scope, signal)
                        await blobs.put(scope, recording, bytes, signal)
                    }
                    await check(scope, signal)
                    return (await persist(scope, record, { phase: 'review', error: null }, signal)).draft
                } catch (error) {
                    await check(scope, signal)
                    await persist(scope, record, { phase: 'failed', error: 'Voice upload did not complete. Retry the same recording.' }, signal)
                    if (error instanceof DesktopHttpError) throw error
                    throw new DesktopHttpError(500, 'Voice upload did not complete. Retry the same recording.')
                }
            })
        },

        async transcribe(scope: DesktopVoiceScope, raw: RevisionInput, signal: AbortSignal): Promise<DesktopVoiceDraft> {
            const input = action(scope, raw)
            return exclusive(scope, input.attemptId, async () => {
                await check(scope, signal)
                let record = await required(scope, input.attemptId, input.expectedRevision)
                await check(scope, signal)
                if (record.draft.phase === 'sent') return record.draft
                if (record.draft.phase === 'sending') throw changed()
                if (record.draft.transcript && record.draft.phase === 'ready') return record.draft
                if (!authorities.transcribe || authorities.transcriptionAvailable && !await authorities.transcriptionAvailable()) {
                    const unavailable = await persist(scope, record, { phase: 'unavailable', error: 'Transcription is not configured on this Mac. Your recording is still available for playback and download.' }, signal)
                    return unavailable.draft
                }
                record = await persist(scope, record, { phase: 'transcribing', error: null }, signal)
                try {
                    const bytes = await readVerified(scope, record.draft.recording, signal)
                    await check(scope, signal)
                    const transcript = (await authorities.transcribe({ bytes, format: record.draft.recording.transcriptionFormat, signal })).trim()
                    await check(scope, signal)
                    if (transcript.length > 20_000) throw new DesktopHttpError(413, 'Voice transcript exceeds its limit.')
                    if (!transcript) return (await persist(scope, record, { phase: 'review', transcript: null, error: 'Couldn’t hear anything in that recording.' }, signal)).draft
                    return (await persist(scope, record, { phase: 'ready', transcript, error: null }, signal)).draft
                } catch {
                    await check(scope, signal)
                    await persist(scope, record, { phase: 'failed', error: 'Transcription failed. Retry the saved recording.' }, signal)
                    throw new DesktopHttpError(502, 'Transcription failed. Retry the saved recording.')
                }
            })
        },

        async send(scope: DesktopVoiceScope, raw: RevisionInput, signal: AbortSignal): Promise<DesktopVoiceSendReceipt> {
            const input = action(scope, raw)
            return exclusive(scope, input.attemptId, async () => {
                await check(scope, signal)
                let record = await required(scope, input.attemptId)
                if (record.draft.phase !== 'sent' && record.draft.revision !== input.expectedRevision) throw changed()
                await check(scope, signal)
                const transcript = record.draft.transcript?.trim() ?? ''
                if (record.sendChoice !== undefined && input.modelChoice !== undefined && JSON.stringify(record.sendChoice) !== JSON.stringify(input.modelChoice)) throw changed()
                if (record.draft.phase === 'sent') return { draft: record.draft, text: buildDesktopVoiceMessage(scope, record.draft.recording, transcript), ...(record.draft.dispatch && { dispatch: record.draft.dispatch }) }
                if (!transcript) {
                    return { draft: (await persist(scope, record, { phase: 'review', error: 'Transcribe this recording before sending.' }, signal)).draft, text: null }
                }
                const text = buildDesktopVoiceMessage(scope, record.draft.recording, transcript)
                record = { ...record, sendChoice: record.sendChoice === undefined ? input.modelChoice ?? null : record.sendChoice }
                record = await persist(scope, record, { phase: 'sending', error: null }, signal)
                try {
                    await check(scope, signal)
                    const receipt = await send({ scope, attemptId: input.attemptId, text, recording: record.draft.recording, ...(record.sendChoice && { modelChoice: record.sendChoice }), signal })
                    await check(scope, signal)
                    const sent = await persist(scope, record, { phase: 'sent', messageId: receipt.messageId, error: null, ...(receipt.dispatch && { dispatch: receipt.dispatch }) }, signal)
                    return { draft: sent.draft, text, ...(receipt.dispatch && { dispatch: receipt.dispatch }) }
                } catch {
                    await check(scope, signal)
                    await persist(scope, record, { phase: 'ready', error: 'Voice message acknowledgement is unknown. Retry the same attempt.' }, signal)
                    throw new DesktopHttpError(502, 'Voice message acknowledgement is unknown. Retry the same attempt.')
                }
            })
        },

        async discard(scope: DesktopVoiceScope, raw: RevisionInput, signal: AbortSignal): Promise<void> {
            const input = action(scope, raw)
            return exclusive(scope, input.attemptId, async () => {
                await check(scope, signal)
                const record = await store.read(scope, input.attemptId)
                await check(scope, signal)
                if (!record || !scopeMatches(scope, record.draft.scope) || record.draft.revision !== input.expectedRevision) throw changed()
                if (record.deletion === 'complete') return
                const referenced = () => references(scope, input.attemptId)
                if (['uploading', 'transcribing', 'sending', 'sent'].includes(record.draft.phase) || await referenced()) throw new DesktopHttpError(409, 'This audio is referenced by a saved message, queue or another tab and cannot be removed.')
                await check(scope, signal)
                await store.reserveDiscard(scope, input.attemptId, input.expectedRevision)
                if (await referenced()) throw new DesktopHttpError(409, 'This audio is referenced by a saved message, queue or another tab and cannot be removed.')
                await check(scope, signal)
                await blobs.delete(scope, record.draft.recording, signal)
                await check(scope, signal)
                await store.discard(scope, input.attemptId, input.expectedRevision)
                await check(scope, signal)
            })
        },

        async audio(scope: DesktopVoiceScope, attemptId: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
            const authorize = async () => {
                signal.throwIfAborted()
                if (authorities.audioOwner) await authorities.audioOwner(scope, attemptId, signal)
                else await check(scope, signal)
                signal.throwIfAborted()
            }
            await authorize()
            const record = await required(scope, attemptId)
            const bytes = await readVerified(scope, record.draft.recording, signal, authorize)
            if (bytes.byteLength !== record.draft.recording.byteLength || createHash('sha256').update(bytes).digest('hex') !== record.draft.recording.sha256) throw new DesktopHttpError(409, 'Voice audio changed. Reload the message.')
            return { bytes, mimeType: record.draft.recording.mimeType }
        },
    }
}

export type DesktopVoiceService = ReturnType<typeof createDesktopVoiceService>
