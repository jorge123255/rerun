// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopVoiceDraft } from '../../../../../packages/contracts/src/desktop-voice.ts'
import { useDesktopVoiceMessage } from './useDesktopVoiceMessage'

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
vi.mock('@/lib/desktop/voice/useDesktopVoiceRecorder', () => ({
    useDesktopVoiceRecorder: () => ({ status: 'idle', stream: null, getLiveState: () => ({ durationMs: 0 }), start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
}))

let root: Root | undefined
let api: ReturnType<typeof useDesktopVoiceMessage>
function Probe() {
    api = useDesktopVoiceMessage(scope)
    return null
}

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.clearAllMocks()
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
    expect(transport.sendDesktopVoice).toHaveBeenCalledWith(scope, draft.attemptId, draft.revision)
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
    expect(transport.discardDesktopVoice).toHaveBeenCalledWith(scope, draft.attemptId, draft.revision)
    expect(api.status).toBe('idle')
    expect(transport.uploadDesktopVoice).not.toHaveBeenCalled()
    expect(transport.transcribeDesktopVoice).not.toHaveBeenCalled()
})
