import { parseVoiceMessage } from '@rerun/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopVoiceService } from './service'
import { desktopVoiceApi } from './api'
import { uploadDesktopVoice, transcribeDesktopVoice, sendDesktopVoice, readDesktopVoiceDraft, listDesktopVoiceDrafts } from '../../voice/client'
import type { DesktopVoiceAttemptRecord, DesktopVoiceBlobStore, DesktopVoiceStore } from './types'
import type { DesktopVoiceScope } from '@rerun/contracts'

const scope: DesktopVoiceScope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'session-1' }
const attemptId = '11111111-1111-4111-8111-111111111111'
const format = { mimeType: 'audio/webm;codecs=opus', extension: 'webm' as const, transcriptionFormat: 'webm' as const }
const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, ...new TextEncoder().encode('webm')])
const upload = { ...scope, attemptId, format, durationMs: 1200, levels: [0, 0.5, 1] }

function fixture(overrides: { transcribe?: (input: { bytes: Uint8Array; format: string; signal: AbortSignal }) => Promise<string>; referenced?: boolean } = {}) {
    const records = new Map<string, DesktopVoiceAttemptRecord>()
    const clone = <T,>(value: T): T => structuredClone(value)
    const store: DesktopVoiceStore = {
        async reserve(record) {
            const existing = records.get(record.draft.attemptId)
            if (existing) return { record: clone(existing), created: false }
            records.set(record.draft.attemptId, clone(record))
            return { record: clone(record), created: true }
        },
        async read(scope, attemptId) { return clone(records.get(attemptId) ?? null) },
        async list() { return clone([...records.values()]) },
        async save(record, expectedRevision) {
            const current = records.get(record.draft.attemptId)
            if (current?.draft.revision !== expectedRevision || current.deletion) throw new Error('revision conflict')
            records.set(record.draft.attemptId, clone(record))
        },
        async reserveDiscard(_scope, attemptId, expectedRevision) {
            const record = records.get(attemptId)
            if (!record || record.draft.revision !== expectedRevision || record.deletion === 'complete' || ['uploading', 'sending', 'sent'].includes(record.draft.phase)) throw new Error('revision conflict')
            records.set(attemptId, { ...record, deletion: 'pending' })
        },
        async discard(_scope, attemptId, expectedRevision) {
            const record = records.get(attemptId)
            if (!record?.deletion || record.draft.revision !== expectedRevision) throw new Error('revision conflict')
            records.set(attemptId, { ...record, deletion: 'complete' })
        },
    }
    const audio = new Map<string, Uint8Array>()
    const puts = vi.fn(async (_scope: DesktopVoiceScope, recording: DesktopVoiceAttemptRecord['draft']['recording'], value: Uint8Array) => { audio.set(recording.attemptId, value) })
    const blobs: DesktopVoiceBlobStore = {
        put: puts,
        async read(_scope, recording) {
            const value = audio.get(recording.attemptId)
            if (!value) throw new Error('missing')
            return value
        },
        async delete(_scope, recording) { audio.delete(recording.attemptId) },
    }
    const send = vi.fn(async (_input: import('@rerun/contracts').DesktopVoiceSendInput & { signal: AbortSignal }) => ({ messageId: 'message-1' }))
    const references = vi.fn(async () => overrides.referenced ?? false)
    const owner = vi.fn(async (_scope: DesktopVoiceScope, signal: AbortSignal) => { signal.throwIfAborted() })
    const authorities = { store, blobs, owner, send, references, transcribe: overrides.transcribe }
    const service = createDesktopVoiceService(authorities)
    return { service, records, audio, puts, send, references, owner, store, blobs, authorities }
}

describe('desktop voice durable lifecycle', () => {
    it('deduplicates acknowledged upload and refuses conflicting bytes under the same attempt', async () => {
        const f = fixture()
        const first = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        const second = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        expect(second.recording.sha256).toBe(first.recording.sha256)
        expect(f.puts).toHaveBeenCalledTimes(1)
        await expect(f.service.upload(scope, upload, Uint8Array.from([...bytes, 0]), new AbortController().signal)).rejects.toThrow('voice attempt changed')
        expect(f.puts).toHaveBeenCalledTimes(1)
    })

    it('keeps review and immutable playback available when transcription is not configured', async () => {
        const f = fixture()
        const uploaded = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        const unavailable = await f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)
        expect(unavailable).toMatchObject({ phase: 'unavailable', transcript: null })
        expect(f.send).not.toHaveBeenCalled()
        const audio = await f.service.audio(scope, attemptId, new AbortController().signal)
        expect(audio.bytes).toEqual(bytes)
    })

    it('reuses upload/transcription after failure and preserves ready state after a lost send acknowledgement', async () => {
        let attempts = 0
        const f = fixture({ transcribe: async () => ++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('recognized text') })
        const uploaded = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        await expect(f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)).rejects.toThrow('Transcription failed')
        const failed = await f.service.draft(scope, attemptId, new AbortController().signal)
        const ready = await f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: failed!.revision }, new AbortController().signal)
        expect(ready).toMatchObject({ phase: 'ready', transcript: 'recognized text' })
        expect(f.puts).toHaveBeenCalledTimes(1)

        f.send.mockRejectedValueOnce(new Error('acknowledgement lost'))
        await expect(f.service.send(scope, { ...scope, attemptId, expectedRevision: ready.revision }, new AbortController().signal)).rejects.toThrow('acknowledgement is unknown')
        const uncertain = await f.service.draft(scope, attemptId, new AbortController().signal)
        expect(uncertain).toMatchObject({ phase: 'ready', transcript: 'recognized text' })
        const sent = await f.service.send(scope, { ...scope, attemptId, expectedRevision: uncertain!.revision }, new AbortController().signal)
        expect(sent.draft).toMatchObject({ phase: 'sent', messageId: 'message-1' })
        expect(parseVoiceMessage(sent.text!)).toMatchObject({ transcript: 'recognized text', durationMs: 1200 })
        expect(f.send).toHaveBeenCalledTimes(2)
        expect(f.send.mock.calls.every(call => call[0].attemptId === attemptId)).toBe(true)
    })

    it('does not publish or send after cancelled transcription', async () => {
        const f = fixture({ transcribe: async ({ signal }) => {
            signal.throwIfAborted()
            return 'too late'
        } })
        const uploaded = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        const controller = new AbortController()
        controller.abort()
        await expect(f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, controller.signal)).rejects.toThrow()
        expect(f.send).not.toHaveBeenCalled()
        const draft = await f.service.draft(scope, attemptId, new AbortController().signal)
        expect(draft!.transcript).toBeNull()
    })

    it('restores persisted attempts without auto-transcribing or sending and reports missing bytes honestly', async () => {
        const f = fixture()
        const uploaded = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        const restored = await f.service.list(scope, new AbortController().signal)
        expect(restored).toHaveLength(1)
        expect(restored[0]).toMatchObject({ phase: 'review', transcript: null })
        expect(f.send).not.toHaveBeenCalled()

        f.audio.clear()
        const missing = await f.service.draft(scope, attemptId, new AbortController().signal)
        expect(missing).toMatchObject({ phase: 'failed', transcript: null })
        expect(missing!.error).toContain('unacknowledged microphone chunks')
        expect(uploaded.recording.byteLength).toBe(bytes.byteLength)
    })

    it.each([false, true])('allows discarding an interrupted transcription only when its recording is unreferenced (referenced=%s)', async referenced => {
        let entered!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        const transcribe = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
            entered()
            await new Promise<void>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
            return 'unreachable'
        })
        const f = fixture({ transcribe, referenced })
        const signal = new AbortController().signal
        const uploaded = await f.service.upload(scope, upload, bytes, signal)
        const controller = new AbortController()
        const inFlight = f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, controller.signal)
        await started
        const stopped = expect(inFlight).rejects.toHaveProperty('name', 'AbortError')
        controller.abort()
        await stopped

        const restarted = createDesktopVoiceService(f.authorities)
        const [draft] = await restarted.list(scope, signal)
        expect(draft).toMatchObject({ phase: 'transcribing', transcript: null })
        await expect(restarted.discard(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, signal)).rejects.toThrow('voice attempt changed')
        const discard = restarted.discard(scope, { ...scope, attemptId, expectedRevision: draft!.revision }, signal)
        if (referenced) {
            await expect(discard).rejects.toThrow('referenced')
            expect(f.audio.get(attemptId)).toEqual(bytes)
        } else {
            await discard
            expect(f.audio.has(attemptId)).toBe(false)
            expect(await restarted.list(scope, signal)).toEqual([])
        }
        expect(transcribe).toHaveBeenCalledOnce()
        expect(f.send).not.toHaveBeenCalled()
    })

    it('refuses referenced cleanup and deletes only exact unreferenced audio', async () => {
        const referenced = fixture({ referenced: true })
        const uploaded = await referenced.service.upload(scope, upload, bytes, new AbortController().signal)
        await expect(referenced.service.discard(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)).rejects.toThrow('referenced')
        expect(referenced.audio.has(attemptId)).toBe(true)

        const f = fixture()
        const draft = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        await f.service.discard(scope, { ...scope, attemptId, expectedRevision: draft.revision }, new AbortController().signal)
        expect(f.audio.has(attemptId)).toBe(false)
        expect(await f.service.draft(scope, attemptId, new AbortController().signal)).toBeNull()
    })

    it('revalidates owner before every operation', async () => {
        const f = fixture()
        await f.service.upload(scope, upload, bytes, new AbortController().signal)
        expect(f.owner).toHaveBeenCalled()
        expect(f.owner.mock.calls.every(call => call[0] === scope)).toBe(true)
    })

    it('does not let a discard waiting on references delete a concurrently sent recording', async () => {
        const f = fixture({ transcribe: async () => 'recognized text' }), signal = new AbortController().signal
        const uploaded = await f.service.upload(scope, upload, bytes, signal)
        const ready = await f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, signal)
        let entered!: () => void, release!: () => void
        const waiting = new Promise<void>(resolve => { entered = resolve })
        const gate = new Promise<void>(resolve => { release = resolve })
        f.references.mockImplementationOnce(async () => { entered(); await gate; return false })
        const discard = f.service.discard(scope, { ...scope, attemptId, expectedRevision: ready.revision }, signal).then(() => 'deleted', () => 'refused')
        await waiting
        const concurrent = createDesktopVoiceService(f.authorities)
        const sent = await concurrent.send(scope, { ...scope, attemptId, expectedRevision: ready.revision }, signal)
        release()
        expect(await discard).toBe('refused')
        expect(sent.draft.phase).toBe('sent')
        expect(f.audio.has(attemptId)).toBe(true)
        expect((await f.service.draft(scope, attemptId, signal))?.phase).toBe('sent')
        expect(await f.service.list(scope, signal)).toEqual([])
    })

    it('reserves deletion before bytes and refuses concurrent send from another service instance', async () => {
        const f = fixture({ transcribe: async () => 'recognized text' }), signal = new AbortController().signal
        const uploaded = await f.service.upload(scope, upload, bytes, signal)
        const ready = await f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, signal)
        let entered!: () => void, release!: () => void
        const waiting = new Promise<void>(resolve => { entered = resolve })
        const gate = new Promise<void>(resolve => { release = resolve })
        const remove = f.blobs.delete.bind(f.blobs)
        f.blobs.delete = async (...args) => { entered(); await gate; await remove(...args) }
        const discard = f.service.discard(scope, { ...scope, attemptId, expectedRevision: ready.revision }, signal)
        await waiting
        try {
            await expect(createDesktopVoiceService(f.authorities).send(scope, { ...scope, attemptId, expectedRevision: ready.revision }, signal)).rejects.toThrow()
            expect(f.send).not.toHaveBeenCalled()
        } finally { release() }
        await discard
        expect(f.audio.has(attemptId)).toBe(false)
    })

    it('finishes a pending byte deletion after restart and never reuploads a discarded attempt', async () => {
        const f = fixture(), signal = new AbortController().signal
        const draft = await f.service.upload(scope, upload, bytes, signal)
        const finalize = f.store.discard.bind(f.store)
        let failOnce = true
        f.store.discard = async (...args) => {
            if (failOnce) { failOnce = false; throw new Error('metadata unavailable') }
            await finalize(...args)
        }
        const input = { ...scope, attemptId, expectedRevision: draft.revision }
        await expect(f.service.discard(scope, input, signal)).rejects.toThrow('metadata unavailable')
        expect(f.audio.has(attemptId)).toBe(false)
        expect(f.records.get(attemptId)?.deletion).toBe('pending')
        const restarted = createDesktopVoiceService(f.authorities)
        await restarted.discard(scope, input, signal)
        await restarted.discard(scope, input, signal)
        expect(await restarted.draft(scope, attemptId, signal)).toBeNull()
        await expect(restarted.upload(scope, upload, bytes, signal)).rejects.toThrow('voice attempt changed')
        expect(f.puts).toHaveBeenCalledTimes(1)
    })

    it.each(['audio read', 'transcription'] as const)('does not publish after owner revocation during %s', async boundary => {
        let allowed = true
        const f = fixture({ transcribe: async () => { if (boundary === 'transcription') allowed = false; return 'private late transcript' } })
        f.owner.mockImplementation(async (_scope, signal) => { signal.throwIfAborted(); if (!allowed) throw new Error('owner revoked') })
        const signal = new AbortController().signal
        const uploaded = await f.service.upload(scope, upload, bytes, signal)
        if (boundary === 'audio read') {
            const read = f.blobs.read.bind(f.blobs)
            f.blobs.read = async (...args) => { const value = await read(...args); allowed = false; return value }
        }
        await expect(f.service.transcribe(scope, { ...scope, attemptId, expectedRevision: uploaded.revision }, signal)).rejects.toThrow('owner revoked')
        expect(f.records.get(attemptId)?.draft.transcript).toBeNull()
        expect(f.send).not.toHaveBeenCalled()
    })

    it('carries the actual client wire envelopes through API, service, send and passive restore', async () => {
        const f = fixture({ transcribe: async () => 'wire transcript' })
        const api = desktopVoiceApi(f.service)
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => api(new Request(new URL(url, 'http://localhost'), init), scope.agentId))
        try {
            const draft = await uploadDesktopVoice(scope, attemptId, { blob: new Blob([bytes]), durationMs: upload.durationMs, levels: upload.levels, format })
            expect(draft.phase).toBe('review')
            const ready = await transcribeDesktopVoice(scope, attemptId, draft.revision)
            expect(ready.transcript).toBe('wire transcript')
            const sent = await sendDesktopVoice(scope, attemptId, ready.revision)
            expect(sent.draft.phase).toBe('sent')
            expect((await readDesktopVoiceDraft(scope, attemptId))?.messageId).toBe('message-1')
            expect(await listDesktopVoiceDrafts(scope)).toEqual([])
            expect(f.send).toHaveBeenCalledTimes(1)
        } finally { vi.unstubAllGlobals() }
    })

    it('refuses a response carrying another chat owner despite a valid draft shape', async () => {
        const f = fixture()
        const draft = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        vi.stubGlobal('fetch', async () => Response.json({ draft: { ...draft, scope: { ...scope, sessionId: 'other-session' } } }))
        try {
            await expect(readDesktopVoiceDraft(scope, attemptId)).rejects.toThrow('another conversation or attempt')
        } finally { vi.unstubAllGlobals() }
    })
})
