// @vitest-environment happy-dom
import { act, type ButtonHTMLAttributes } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { ForemanVoiceSlot } from './ForemanVoiceSlot'
import type { ForemanVoiceSlotController } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }))
vi.mock('@/components/foreman/dock/ForemanPillVoice', () => ({ ForemanPillVoice: () => <span>Listening · release Space to send</span> }))
vi.mock('@rerun/ui', () => ({ TextShimmer: ({ children }: { children: string }) => <span>{children}</span> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); vi.useRealTimers(); document.body.innerHTML = '' })
test('pointer release preserves the send interaction when pointer capture is normally lost', async () => {
    vi.useFakeTimers()
    const start = vi.fn(async () => {}), release = vi.fn(async () => {}), cancel = vi.fn(async () => {})
    const voice = { controller: { start, release, cancel, getSnapshot: () => ({ phase: 'listening' }) }, view: { phase: 'idle', pending: null, error: null, restored: true, snapshot: null }, stream: null, releasePolicy: 'send', active: true } as unknown as ForemanVoiceSlotController
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<ForemanVoiceSlot voice={voice} onOpenTranscriptionSettings={vi.fn()} />))
    const button = host.querySelector('button')!
    button.setPointerCapture = vi.fn()
    await act(async () => { button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true })); vi.advanceTimersByTime(200) })
    expect(start).toHaveBeenCalledOnce()
    await act(async () => {
        button.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true }))
        button.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }))
    })
    expect(release).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled()
})
test('transcription setup opens the existing settings callback, without creating credentials or a reply', async () => {
    const setup = vi.fn(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    const voice = { controller: {}, view: { phase: 'review', pending: null, error: 'Transcription is not configured on this Mac.', snapshot: { setup: 'transcription' }, restored: true }, stream: null, releasePolicy: 'send', active: true } as unknown as ForemanVoiceSlotController
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<ForemanVoiceSlot voice={voice} onOpenTranscriptionSettings={setup} />))
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Set up transcription')!
    await act(async () => button.click())
    expect(setup).toHaveBeenCalledOnce(); expect(host.querySelector('input')).toBeNull()
})
test('closing eligibility clears a pending pointer hold before it can reopen the microphone', async () => {
    vi.useFakeTimers()
    const start = vi.fn(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    const voice = { controller: { start }, view: { phase: 'idle', pending: null, error: null, restored: true, snapshot: null }, stream: null, releasePolicy: 'send', active: true } as unknown as ForemanVoiceSlotController
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<ForemanVoiceSlot voice={voice} onOpenTranscriptionSettings={vi.fn()} />))
    const button = host.querySelector('button')!; button.setPointerCapture = vi.fn()
    await act(async () => { button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true })); vi.advanceTimersByTime(100) })
    await act(async () => root.render(<ForemanVoiceSlot voice={{ ...voice, active: false }} onOpenTranscriptionSettings={vi.fn()} />))
    await act(async () => vi.advanceTimersByTime(200))
    expect(start).not.toHaveBeenCalled()
})
