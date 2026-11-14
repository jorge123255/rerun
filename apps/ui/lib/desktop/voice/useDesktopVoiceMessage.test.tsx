// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopVoiceDraft } from '@rerun/contracts'
import { useDesktopVoiceMessage } from './useDesktopVoiceMessage'
import { buildDesktopVoiceMessage } from './voice'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'

const scope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'session-1' }
const draft: DesktopVoiceDraft = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    scope,
    phase: 'ready',
    revision: '22222222-2222-4222-8222-222222222222',
    recording: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        sha256: 'a'.repeat(64),
        byteLength: 4,
        mimeType: 'audio/webm',
        extension: 'webm',
        transcriptionFormat: 'webm',
        durationMs: 1200,
        levels: [0, 0.5, 1],
    },
    transcript: 'recognized text',
    error: null,
    messageId: null,
    updatedAt: '2026-11-05T00:00:00.000Z',
}
const transport = vi.hoisted(() => ({
    listDesktopVoiceDrafts: vi.fn(),
    readDesktopVoiceDraft: vi.fn(),
    uploadDesktopVoice: vi.fn(),
    transcribeDesktopVoice: vi.fn(),
    sendDesktopVoice: vi.fn(),
    discardDesktopVoice: vi.fn(),
}))
vi.mock('@/lib/desktop/voice/client', () => transport)
const recorder = vi.hoisted(() => ({ status: 'idle', stream: null, getLiveState: () => ({ durationMs: 0 }), start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }))
vi.mock('@/lib/desktop/voice/useDesktopVoiceRecorder', () => ({
    useDesktopVoiceRecorder: () => recorder,
}))

let root: Root | undefined
let api: ReturnType<typeof useDesktopVoiceMessage>
function Probe({ currentScope = scope, active = true, modelChoice, onSent }: { currentScope?: typeof scope; active?: boolean; modelChoice?: Parameters<typeof useDesktopVoiceMessage>[0]['modelChoice']; onSent?: Parameters<typeof useDesktopVoiceMessage>[0]['onSent'] }) {
    const value = useDesktopVoiceMessage({ ...currentScope, active, modelChoice, onSent })
    useLayoutEffect(() => { api = value })
    return null
}

beforeEach(() => {
    cancelDraftShutdown()
    for (const mock of Object.values(transport)) mock.mockReset()
    recorder.start.mockReset().mockResolvedValue(true)
    recorder.cancel.mockReset().mockResolvedValue(null)
    recorder.stop.mockReset().mockResolvedValue({ blob: new Blob(['recorded']), durationMs: 1200, levels: [0.5], format: { mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm' } })
    transport.listDesktopVoiceDrafts.mockResolvedValue([])
    transport.uploadDesktopVoice.mockImplementation(async (owner, attemptId) => ({ ...draft, scope: owner, attemptId, recording: { ...draft.recording, attemptId }, phase: 'review', transcript: null }))
})

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.clearAllMocks()
    cancelDraftShutdown()
})

it('restores into ready without work and retains transcript/upload identity through a lost send acknowledgement', async () => {
    transport.listDesktopVoiceDrafts.mockResolvedValue([draft])
    transport.readDesktopVoiceDraft.mockResolvedValue(draft)
    transport.sendDesktopVoice.mockRejectedValueOnce(new Error('acknowledgement lost')).mockResolvedValue({ draft: { ...draft, phase: 'sent', messageId: 'message-1' }, text: 'voice-message' })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))

    expect(api.status).toBe('ready')
    expect(api.transcript).toBe('recognized text')
    expect(transport.uploadDesktopVoice).not.toHaveBeenCalled()
    expect(transport.transcribeDesktopVoice).not.toHaveBeenCalled()
    expect(transport.sendDesktopVoice).not.toHaveBeenCalled()

    await act(async () => { await api.send() })
    expect(transport.sendDesktopVoice).toHaveBeenCalledWith(scope, draft.attemptId, draft.revision, expect.any(AbortSignal))
    expect(api.transcript).toBe('recognized text')
    await act(async () => { await api.retry() })
    expect(transport.sendDesktopVoice).toHaveBeenCalledTimes(2)
    for (const call of transport.sendDesktopVoice.mock.calls) expect(call[0]).toEqual(scope)
    expect(transport.sendDesktopVoice.mock.calls.every(call => call[1] === draft.attemptId)).toBe(true)
})

it('discard uses the exact restored attempt and does not start another recording', async () => {
    transport.listDesktopVoiceDrafts.mockResolvedValue([{ ...draft, phase: 'review', transcript: null }])
    transport.discardDesktopVoice.mockResolvedValue(undefined)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { expect(await api.discard()).toBe(true) })
    expect(transport.discardDesktopVoice).toHaveBeenCalledWith(scope, draft.attemptId, draft.revision, expect.any(AbortSignal))
    expect(api.status).toBe('idle')
    expect(transport.uploadDesktopVoice).not.toHaveBeenCalled()
    expect(transport.transcribeDesktopVoice).not.toHaveBeenCalled()
})

it('attaches the accepted reply when read-back confirms a send whose response was lost', async () => {
    const dispatch = { sessionId: scope.sessionId, runId: draft.attemptId }
    const sent: DesktopVoiceDraft = { ...draft, phase: 'sent', dispatch, messageId: 'message-1' }
    transport.listDesktopVoiceDrafts.mockResolvedValue([draft])
    transport.sendDesktopVoice.mockRejectedValueOnce(new Error('send response lost'))
    transport.readDesktopVoiceDraft.mockResolvedValue(sent)
    const onSent = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe onSent={onSent} />))
    expect(onSent).not.toHaveBeenCalled()

    await act(async () => api.send())
    expect(api.status).toBe('sent')
    expect(onSent).toHaveBeenCalledExactlyOnceWith({
        draft: sent, dispatch, text: buildDesktopVoiceMessage(scope, draft.recording, draft.transcript!),
    })
    expect(transport.sendDesktopVoice).toHaveBeenCalledOnce()
    expect(transport.transcribeDesktopVoice).not.toHaveBeenCalled()
})

it('keeps a pre-session recording on its authenticated original scope after the first reply', async () => {
    const originalScope = { agentId: scope.agentId, tabUid: scope.tabUid }
    const original = { ...draft, scope: originalScope }
    transport.listDesktopVoiceDrafts.mockResolvedValue([{ ...original, phase: 'review', transcript: null }])
    transport.transcribeDesktopVoice.mockResolvedValue(original)
    transport.discardDesktopVoice.mockResolvedValue(undefined)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.transcribe() })
    expect(transport.transcribeDesktopVoice).toHaveBeenCalledWith(originalScope, original.attemptId, original.revision, expect.any(AbortSignal))
    await act(async () => { expect(await api.discard()).toBe(true) })
    expect(transport.discardDesktopVoice).toHaveBeenCalledWith(originalScope, original.attemptId, original.revision, expect.any(AbortSignal))
})

it('restores the durable send choice and original scope instead of replacing them with the current picker', async () => {
    const originalScope = { agentId: scope.agentId, tabUid: scope.tabUid }
    const currentChoice = { connectionId: 'codex', model: 'gpt-6.1-sol' }
    const savedChoice = { connectionId: 'codex', model: 'gpt-6.1-terra' }
    const original = { ...draft, scope: originalScope, sendModelChoice: savedChoice }
    transport.listDesktopVoiceDrafts.mockResolvedValue([original])
    transport.sendDesktopVoice.mockResolvedValue({ draft: { ...original, phase: 'sent', messageId: 'message-original' }, text: 'voice-message' })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe modelChoice={currentChoice} />))
    await act(async () => { await api.send() })
    expect(transport.sendDesktopVoice).toHaveBeenCalledWith(originalScope, original.attemptId, original.revision, expect.any(AbortSignal), savedChoice)
})

it('restores an explicitly reserved default model after restart', async () => {
    const original = { ...draft, sendModelChoice: null }
    transport.listDesktopVoiceDrafts.mockResolvedValue([original])
    transport.sendDesktopVoice.mockResolvedValue({ draft: { ...original, phase: 'sent', messageId: 'message-default' }, text: 'voice-message' })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe modelChoice={{ connectionId: 'codex', model: 'gpt-6.1-terra' }} />))
    await act(async () => { await api.send() })
    expect(transport.sendDesktopVoice).toHaveBeenCalledWith(scope, draft.attemptId, draft.revision, expect.any(AbortSignal))
})

it('keeps its upload attempt when both the upload acknowledgement and read-back are lost', async () => {
    transport.uploadDesktopVoice.mockRejectedValueOnce(new Error('upload acknowledgement lost')).mockImplementation(async (_scope, attemptId) => ({ ...draft, attemptId, recording: { ...draft.recording, attemptId }, phase: 'review', transcript: null }))
    transport.readDesktopVoiceDraft.mockRejectedValue(new Error('read-back unavailable'))
    transport.transcribeDesktopVoice.mockImplementation(async (_scope, attemptId) => ({ ...draft, attemptId, recording: { ...draft.recording, attemptId } }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.start() })
    await act(async () => { await api.finish() })
    const attemptId = transport.uploadDesktopVoice.mock.calls[0]![1]
    expect(api.attemptId).toBe(attemptId)
    expect(api.status).toBe('failed')
    await act(async () => { await api.retry() })
    expect(transport.uploadDesktopVoice).toHaveBeenCalledTimes(2)
    expect(transport.uploadDesktopVoice.mock.calls.every(call => call[1] === attemptId)).toBe(true)
    expect(api.draft?.attemptId).toBe(attemptId)
    expect(api.status).toBe('ready')
})

it('saves raw recording on Finish before the user chooses transcription', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.start() })
    await act(async () => { await api.finish() })
    expect(transport.uploadDesktopVoice).toHaveBeenCalledTimes(1)
    expect(transport.uploadDesktopVoice.mock.calls[0]![0]).toEqual(scope)
    expect(api.draft?.phase).toBe('review')
    expect(api.take).toBeNull()
    expect(transport.transcribeDesktopVoice).not.toHaveBeenCalled()
    expect(transport.sendDesktopVoice).not.toHaveBeenCalled()
})

it('hiding the active chat stops the microphone and saves the original take', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.start() })
    await act(async () => root!.render(<Probe active={false} />))
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(transport.uploadDesktopVoice).toHaveBeenCalledTimes(1)
    expect(api.status).toBe('review')
    expect(transport.transcribeDesktopVoice).not.toHaveBeenCalled()
})

it('a late raw upload survives chat closure without replacing another chat and restores its own draft', async () => {
    let finish!: (value: DesktopVoiceDraft) => void
    transport.uploadDesktopVoice.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.start() })
    await act(async () => root!.render(<Probe currentScope={{ ...scope, agentId: 'other-owner' }} />))
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(transport.uploadDesktopVoice.mock.calls[0]![0]).toEqual(scope)
    const attemptId = transport.uploadDesktopVoice.mock.calls[0]![1]
    expect(api.draft).toBeNull()
    const saved = { ...draft, attemptId, recording: { ...draft.recording, attemptId }, phase: 'review' as const, transcript: null }
    await act(async () => { finish(saved) })
    expect(api.status).toBe('idle')
    expect(api.draft).toBeNull()
    transport.listDesktopVoiceDrafts.mockResolvedValue([saved])
    await act(async () => root!.render(<Probe />))
    expect(api.draft?.attemptId).toBe(attemptId)
    expect(api.status).toBe('review')
})

it('quit stops capture synchronously and waits for the raw upload acknowledgement', async () => {
    let finish!: (value: DesktopVoiceDraft) => void
    transport.uploadDesktopVoice.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.start() })
    let flushed = false, flushing!: Promise<boolean>
    await act(async () => { flushing = flushDesktopDrafts().then(value => { flushed = true; return value }); await Promise.resolve() })
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(flushed).toBe(false)
    expect(api.status).toBe('uploading')
    const attemptId = transport.uploadDesktopVoice.mock.calls[0]![1]
    await act(async () => {
        finish({ ...draft, attemptId, recording: { ...draft.recording, attemptId }, phase: 'review', transcript: null })
        expect(await flushing).toBe(true)
    })
    expect(api.draft?.attemptId).toBe(attemptId)
    expect(transport.transcribeDesktopVoice).not.toHaveBeenCalled()
})

it('unmount preserves a finishing raw take and remount joins its exact scope instead of starting another capture', async () => {
    let finish!: (value: DesktopVoiceDraft) => void
    transport.uploadDesktopVoice.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.start() })
    await act(async () => root!.unmount())
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    const attemptId = transport.uploadDesktopVoice.mock.calls[0]![1]
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    expect(api.status).toBe('uploading')
    await act(async () => { finish({ ...draft, attemptId, recording: { ...draft.recording, attemptId }, phase: 'review', transcript: null }) })
    expect(api.draft?.attemptId).toBe(attemptId)
    expect(recorder.start).toHaveBeenCalledTimes(1)
    expect(transport.uploadDesktopVoice).toHaveBeenCalledTimes(1)
})

it('retries the original model choice and forwards the accepted dispatch receipt', async () => {
    const first = { connectionId: 'codex', model: 'terra' }, changed = { connectionId: 'codex', model: 'sol' }, onSent = vi.fn()
    const dispatch = { sessionId: 'session-1', runId: 'voice-run' }
    transport.listDesktopVoiceDrafts.mockResolvedValue([draft])
    transport.readDesktopVoiceDraft.mockResolvedValue(draft)
    transport.sendDesktopVoice.mockRejectedValueOnce(new Error('Lost response')).mockResolvedValue({ draft: { ...draft, phase: 'sent', messageId: 'message-1', dispatch }, text: 'voice-message', dispatch })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe modelChoice={first} onSent={onSent} />))
    await act(async () => { await api.send() })
    await act(async () => root!.render(<Probe modelChoice={changed} onSent={onSent} />))
    await act(async () => { await api.retry() })
    expect(transport.sendDesktopVoice.mock.calls.map(call => call[4])).toEqual([first, first])
    expect(onSent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'voice-message', dispatch }))
})

it('retains an acknowledged upload when transcription and read-back fail', async () => {
    transport.uploadDesktopVoice.mockImplementation(async (_scope, attemptId) => ({ ...draft, attemptId, recording: { ...draft.recording, attemptId }, phase: 'review', transcript: null }))
    transport.transcribeDesktopVoice.mockRejectedValueOnce(new Error('transcription failed')).mockImplementation(async (_scope, attemptId) => ({ ...draft, attemptId, recording: { ...draft.recording, attemptId } }))
    transport.readDesktopVoiceDraft.mockRejectedValue(new Error('read-back unavailable'))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.start() })
    await act(async () => { await api.finish() })
    await act(async () => { await api.transcribe() })
    const attemptId = transport.uploadDesktopVoice.mock.calls[0]![1]
    expect(api.draft?.attemptId).toBe(attemptId)
    await act(async () => { await api.retry() })
    expect(transport.uploadDesktopVoice).toHaveBeenCalledTimes(1)
    expect(transport.transcribeDesktopVoice).toHaveBeenLastCalledWith(scope, attemptId, draft.revision, expect.any(AbortSignal))
})

it('records another message after send without discarding the history audio', async () => {
    transport.listDesktopVoiceDrafts.mockResolvedValue([draft])
    transport.sendDesktopVoice.mockResolvedValue({ draft: { ...draft, phase: 'sent', messageId: 'message-1' }, text: 'voice-message' })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => { await api.send() })
    await act(async () => { await api.rerecord() })
    expect(transport.discardDesktopVoice).not.toHaveBeenCalled()
    expect(recorder.start).toHaveBeenCalledTimes(1)
    expect(api.status).toBe('recording')
    expect(api.draft).toBeNull()
})

it('leaves sent history out of the restored composer and ignores an old owner discard failure', async () => {
    transport.listDesktopVoiceDrafts.mockResolvedValueOnce([{ ...draft, phase: 'review', transcript: null }]).mockResolvedValue([{ ...draft, phase: 'sent' }])
    let reject!: (error: Error) => void
    transport.discardDesktopVoice.mockImplementation(() => new Promise((_resolve, no) => { reject = no }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    let pending!: Promise<boolean>
    await act(async () => { pending = api.discard(); await Promise.resolve() })
    await act(async () => root!.render(<Probe currentScope={{ ...scope, agentId: 'other-owner' }} />))
    await act(async () => { reject(new Error('old owner failure')); expect(await pending).toBe(false) })
    expect(api.status).toBe('idle')
    expect(api.error).toBeNull()
    expect(api.draft).toBeNull()
    expect(recorder.start).not.toHaveBeenCalled()
})
