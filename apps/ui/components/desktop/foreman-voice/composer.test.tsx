// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopForemanComposer } from '@/components/desktop/foreman/DesktopForemanComposer'
import type { ForemanVoiceView } from '@/lib/desktop/foreman-voice/controller'
import type { ForemanVoiceSlotController } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
import { ForemanVoiceSlot } from './ForemanVoiceSlot'

const playback = vi.hoisted(() => ({ toggle: vi.fn(async () => {}) }))
vi.mock('@/lib/desktop/voice/useDesktopVoicePlayback', () => ({ useDesktopVoicePlayback: () => ({ ...playback, loading: false, playing: false, audioRef: { current: null }, audioProps: {}, error: null }) }))
vi.mock('@/components/desktop/voice/DesktopVoiceWaveform', () => ({ DesktopVoiceWaveform: () => null }))
vi.mock('@/components/foreman/dock/ForemanPillVoice', () => ({ ForemanPillVoice: () => null }))
vi.mock('@rerun/ui', () => ({ TextShimmer: ({ children }: { children: string }) => <span>{children}</span> }))

let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined; document.body.innerHTML = ''; vi.clearAllMocks(); vi.unstubAllGlobals()
})

test('voice controls inside the actual composer preserve its typed draft and dispatch only their own actions', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const id = '00000000-0000-4000-8000-000000000001'
    const target = { chat: { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, model: { connectionId: 'connection', model: 'model' } }
    const pending = { target, attemptId: id, blob: null, format: { mimeType: 'audio/webm', extension: 'webm' as const, transcriptionFormat: 'webm' as const }, durationMs: 1300, levels: [0.2] }
    const review: ForemanVoiceView = {
        phase: 'review', pending, restored: true, error: null,
        snapshot: { target, setup: 'transcription', receipt: null, attempt: { attemptId: id, revision: id, phase: 'failed', recording: { ...pending.format, attemptId: id, sha256: 'a'.repeat(64), byteLength: 4, durationMs: 1300, levels: [0.2] }, transcript: 'Only the voice transcript', error: null, messageId: null, updatedAt: 'now' } },
    }
    const action = () => vi.fn(async () => {})
    const controls = { start: action(), restore: action(), cancel: action(), release: action(), refresh: action(), retrySave: action(), transcribe: action(), send: action(), discard: action(), done: action() }
    const onSend = vi.fn(), setup = vi.fn(), draft = 'Keep my typed draft through every voice action'
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    function Composer({ view }: { view: ForemanVoiceView }) {
        const [text, setText] = useState(draft)
        const voice = { controller: controls, view, stream: null, releasePolicy: 'review', active: true } as unknown as ForemanVoiceSlotController
        return <DesktopForemanComposer draft={text} onDraftChange={setText} onSend={value => { onSend(value); setText('') }} trailing={<ForemanVoiceSlot voice={voice} onOpenTranscriptionSettings={setup} />} />
    }
    const render = async (view: ForemanVoiceView) => { await act(async () => root!.render(<Composer view={view} />)) }
    const click = async (label: string) => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('[data-foreman-voice-controls] button')].find(item => item.textContent === label)!
        expect(button).toBeDefined()
        // An omitted type defaults to submit in a form, even when onClick handles voice work.
        expect(button.type).toBe('button')
        await act(async () => button.click())
        expect(onSend).not.toHaveBeenCalled()
        expect(host.querySelector('textarea')?.value).toBe(draft)
    }
    await render(review)
    for (const label of ['Play voice message', 'Refresh', 'Save recording', 'Set up transcription', 'Transcribe', 'Discard', 'Cancel']) await click(label)
    expect(playback.toggle).toHaveBeenCalledOnce(); expect(controls.refresh).toHaveBeenCalledOnce(); expect(controls.retrySave).toHaveBeenCalledOnce()
    expect(setup).toHaveBeenCalledOnce(); expect(controls.transcribe).toHaveBeenCalledOnce(); expect(controls.discard).toHaveBeenCalledOnce()
    expect(controls.send).not.toHaveBeenCalled()
    await click('Send voice message')
    expect(controls.send).toHaveBeenCalledOnce()

    await render({ phase: 'idle', pending: null, snapshot: null, error: null, restored: false })
    await click('Restore recording')
    expect(controls.restore).toHaveBeenCalledOnce()
    await render({ phase: 'idle', pending: null, snapshot: null, error: null, restored: true })
    await click('Hold to talk')
    await render({ phase: 'error', pending: null, snapshot: null, error: 'Microphone unavailable', restored: true })
    await click('Try again')
    expect(controls.start).toHaveBeenCalledOnce()
    await render({ phase: 'listening', pending: null, snapshot: null, error: null, restored: true })
    await click('Review')
    expect(controls.release).toHaveBeenCalledWith(true)
    await render({ ...review, phase: 'sent', snapshot: { ...review.snapshot!, receipt: { target, attemptId: id, requestId: id, runId: id, accepted: true } } })
    await click('Done')
    expect(controls.done).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
    expect(controls.send).toHaveBeenCalledOnce()
    // The ordinary composer Send remains a separate, intentional submit action.
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(onSend).toHaveBeenCalledExactlyOnceWith(draft)
    expect(host.querySelector('textarea')?.value).toBe('')
})
