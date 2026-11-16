// @vitest-environment happy-dom
import { act, type ButtonHTMLAttributes } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '@/lib/desktop/locale'
import { DesktopLocale } from '../DesktopLocale'
import { ForemanVoiceSlot } from './ForemanVoiceSlot'
import type { ForemanVoiceSlotController } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }))
vi.mock('@/components/ui/live-waveform', () => ({ LiveWaveform: () => null }))
vi.mock('@/components/desktop/voice/DesktopVoiceWaveform', () => ({ DesktopVoiceWaveform: () => null }))
vi.mock('@/lib/desktop/voice/useDesktopVoicePlayback', () => ({ useDesktopVoicePlayback: () => ({ toggle: vi.fn(), loading: false, playing: false, audioRef: { current: null }, audioProps: {}, error: null }) }))
vi.mock('@rerun/ui', () => ({ TextShimmer: ({ children }: { children: string }) => <span>{children}</span> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined; vi.useRealTimers(); document.body.innerHTML = '' })

const actions = () => ({ start: vi.fn(async () => {}), release: vi.fn(async () => {}), cancel: vi.fn(async () => {}) })
const voiceOf = (controller: object, phase: string, extra: object = {}) => ({
    controller, view: { phase, pending: null, error: null, restored: true, snapshot: null, ...extra }, stream: null, releasePolicy: 'send', active: true,
}) as unknown as ForemanVoiceSlotController
function mount() {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    dispose = async () => { await act(async () => root.unmount()) }
    return { host, render: (voice: ForemanVoiceSlotController, wrap = (node: React.ReactNode) => node) =>
        act(async () => root.render(wrap(<ForemanVoiceSlot voice={voice} onOpenTranscriptionSettings={vi.fn()} />))) }
}
const labelled = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(button => button.textContent === text)!

test('one click on the microphone starts the recording; holding it down is not needed and starts nothing by itself', async () => {
    vi.useFakeTimers()
    const controller = actions(), { host, render } = mount()
    await render(voiceOf(controller, 'idle'))
    const mic = host.querySelector<HTMLButtonElement>('[data-foreman-voice-mic]')!
    expect(mic.getAttribute('aria-label')).toBe('Record a voice message')
    expect(host.querySelector('[data-foreman-voice-recording]')).toBeNull()
    await act(async () => { mic.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true })); vi.advanceTimersByTime(1000) })
    expect(controller.start).not.toHaveBeenCalled()
    await act(async () => mic.click())
    expect(controller.start).toHaveBeenCalledOnce()
    expect(controller.release).not.toHaveBeenCalled()
})

test('a recording shows its running time with Cancel and Stop; Stop hands the take to review and sends nothing', async () => {
    vi.useFakeTimers()
    const controller = actions(), { host, render } = mount()
    await render(voiceOf(controller, 'starting'))
    // The microphone is not open yet: there is nothing to stop, but the wait can be cancelled.
    expect(host.querySelector('[data-foreman-voice-recording]')!.getAttribute('data-foreman-voice-recording')).toBe('starting')
    expect(host.textContent).toContain('Waiting for the microphone...')
    expect(host.querySelector<HTMLButtonElement>('[data-foreman-voice-stop]')!.disabled).toBe(true)
    expect(host.querySelector('[data-foreman-voice-mic]')).toBeNull()

    await render(voiceOf(controller, 'listening'))
    const timer = host.querySelector('[data-foreman-voice-timer]')!
    expect(timer.textContent).toBe('0:00')
    await act(async () => { vi.advanceTimersByTime(65_000) })
    expect(timer.textContent).toBe('1:05')
    expect(host.querySelector('[role="status"]')!.textContent).toContain('Recording')
    // One Cancel while recording, not the bar's and the review row's both.
    expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Cancel', 'Stop'])
    const stop = host.querySelector<HTMLButtonElement>('[data-foreman-voice-stop]')!
    expect(stop.disabled).toBe(false)
    expect(stop.getAttribute('aria-label')).toBe('Stop recording')
    await act(async () => stop.click())
    expect(controller.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(controller.cancel).not.toHaveBeenCalled()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-foreman-voice-cancel]')!.click())
    expect(controller.cancel).toHaveBeenCalledOnce()

    // A new recording counts from zero again.
    await render(voiceOf(controller, 'idle'))
    await render(voiceOf(controller, 'listening'))
    expect(host.querySelector('[data-foreman-voice-timer]')!.textContent).toBe('0:00')
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

test('the microphone stays off while the slot is not eligible or its saved recording is not restored', async () => {
    const controller = actions(), { host, render } = mount()
    await render({ ...voiceOf(controller, 'idle'), active: false })
    expect(host.querySelector<HTMLButtonElement>('[data-foreman-voice-mic]')!.disabled).toBe(true)
    await render(voiceOf(controller, 'idle', { restored: false }))
    expect(host.querySelector<HTMLButtonElement>('[data-foreman-voice-mic]')!.disabled).toBe(true)
    expect(labelled(host, 'Restore recording')).toBeDefined()
})

test('recording, review and progress labels follow the Mac language', async () => {
    const french = { preference: 'fr' as const, locale: 'fr' as const, messages: desktopMessages('fr', await loadMessages('fr')) }
    const wrap = (node: React.ReactNode) => <DesktopLocale initial={french}>{node}</DesktopLocale>
    const controller = actions(), { host, render } = mount()
    await render(voiceOf(controller, 'idle'), wrap)
    expect(host.querySelector('[data-foreman-voice-mic]')!.getAttribute('aria-label')).toBe('Enregistrer un message vocal')
    await render(voiceOf(controller, 'listening'), wrap)
    expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Annuler', 'Arrêter'])
    for (const [phase, label] of [['restoring', 'Restauration de l’enregistrement…'], ['saving', 'Sauvegarde de l’enregistrement…'], ['transcribing', 'Transcription…'], ['sending', 'Envoi…']]) {
        await render(voiceOf(controller, phase), wrap)
        expect(host.textContent).toContain(label)
    }
    const target = { chat: { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, model: { connectionId: 'c', model: 'm' } }
    const pending = { target, attemptId: '00000000-0000-4000-8000-000000000001', blob: null, levels: [0.2] }
    await render(voiceOf(controller, 'review', { pending }), wrap)
    expect([...host.querySelectorAll('button')].map(button => button.textContent))
        .toEqual(['Écouter le message vocal', 'Actualiser', 'Sauvegarder l’enregistrement', 'Transcrire', 'Envoyer le message vocal', 'Supprimer', 'Annuler'])
    await render(voiceOf(controller, 'sent', { pending }), wrap)
    expect(host.textContent).toContain('Envoyé')
    expect(labelled(host, 'Terminé')).toBeDefined()
    await render(voiceOf(controller, 'error', { error: 'x' }), wrap)
    expect(labelled(host, 'Réessayer')).toBeDefined()
})
