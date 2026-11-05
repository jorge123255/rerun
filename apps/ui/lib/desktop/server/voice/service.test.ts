import { parseVoiceMessage } from '@rerun/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopVoiceService } from './service'
import type { DesktopVoiceAttemptRecord, DesktopVoiceBlobStore, DesktopVoiceStore } from './types'
import type { DesktopVoiceScope } from '../../../../../../packages/contracts/src/desktop-voice.ts'

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
            if (current?.draft.revision !== expectedRevision) throw new Error('revision conflict')
            records.set(record.draft.attemptId, clone(record))
        },
        async discard(_scope, attemptId) { records.delete(attemptId) },
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
    const send = vi.fn(async (_input: import('../../../../../../packages/contracts/src/desktop-voice.ts').DesktopVoiceSendInput & { signal: AbortSignal }) => ({ messageId: 'message-1' }))
    const references = vi.fn(async () => overrides.referenced ?? false)
    const owner = vi.fn(async () => {})
    const service = createDesktopVoiceService({ store, blobs, owner, send, references, transcribe: overrides.transcribe })
    return { service, records, audio, puts, send, references, owner }
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
        const unavailable = await f.service.transcribe(scope, { attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)
        expect(unavailable).toMatchObject({ phase: 'unavailable', transcript: null })
        expect(f.send).not.toHaveBeenCalled()
        const audio = await f.service.audio(scope, attemptId, new AbortController().signal)
        expect(audio.bytes).toEqual(bytes)
    })

    it('reuses upload/transcription after failure and preserves ready state after a lost send acknowledgement', async () => {
        let attempts = 0
        const f = fixture({ transcribe: async () => ++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('recognized text') })
        const uploaded = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        await expect(f.service.transcribe(scope, { attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)).rejects.toThrow('Transcription failed')
        const failed = await f.service.draft(scope, attemptId, new AbortController().signal)
        const ready = await f.service.transcribe(scope, { attemptId, expectedRevision: failed!.revision }, new AbortController().signal)
        expect(ready).toMatchObject({ phase: 'ready', transcript: 'recognized text' })
        expect(f.puts).toHaveBeenCalledTimes(1)

        f.send.mockRejectedValueOnce(new Error('acknowledgement lost'))
        await expect(f.service.send(scope, { attemptId, expectedRevision: ready.revision }, new AbortController().signal)).rejects.toThrow('acknowledgement is unknown')
        const uncertain = await f.service.draft(scope, attemptId, new AbortController().signal)
        expect(uncertain).toMatchObject({ phase: 'ready', transcript: 'recognized text' })
        const sent = await f.service.send(scope, { attemptId, expectedRevision: uncertain!.revision }, new AbortController().signal)
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
        await expect(f.service.transcribe(scope, { attemptId, expectedRevision: uploaded.revision }, controller.signal)).rejects.toThrow()
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

    it('refuses referenced cleanup and deletes only exact unreferenced audio', async () => {
        const referenced = fixture({ referenced: true })
        const uploaded = await referenced.service.upload(scope, upload, bytes, new AbortController().signal)
        await expect(referenced.service.discard(scope, { attemptId, expectedRevision: uploaded.revision }, new AbortController().signal)).rejects.toThrow('referenced')
        expect(referenced.audio.has(attemptId)).toBe(true)

        const f = fixture()
        const draft = await f.service.upload(scope, upload, bytes, new AbortController().signal)
        await f.service.discard(scope, { attemptId, expectedRevision: draft.revision }, new AbortController().signal)
        expect(f.audio.has(attemptId)).toBe(false)
        expect(await f.service.draft(scope, attemptId, new AbortController().signal)).toBeNull()
    })

    it('revalidates owner before every operation', async () => {
        const f = fixture()
        await f.service.upload(scope, upload, bytes, new AbortController().signal)
        expect(f.owner).toHaveBeenCalled()
        expect(f.owner.mock.calls.every(call => call[0] === scope)).toBe(true)
    })
})
