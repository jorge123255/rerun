// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopVoiceDraft } from '@rerun/contracts'
import { desktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { DesktopVoiceReview } from './DesktopVoiceReview'
import { DesktopLocale } from '../DesktopLocale'
import { desktopMessages } from '@/lib/desktop/locale'
import { loadMessages } from '@rerun/i18n/messages'

const original = { agentId: 'owner', tabUid: 'original-tab' }
const current = { ...original, sessionId: 'bound-session' }
const attemptId = '11111111-1111-4111-8111-111111111111'
const draft: DesktopVoiceDraft = {
    attemptId, scope: original, phase: 'review', revision: '22222222-2222-4222-8222-222222222222',
    recording: { attemptId, sha256: 'a'.repeat(64), byteLength: 1, mimeType: 'audio/webm',
        extension: 'webm', transcriptionFormat: 'webm', durationMs: 1200, levels: [] },
    transcript: null, error: null, messageId: null, updatedAt: '2026-11-05T00:00:00Z',
}
let root: Root | undefined

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

it.each([false, true])('uses the original recording reference and releases it when the chat becomes inactive (loaded=%s)', async loaded => {
    let respond!: (response: Response) => void
    const result = new Promise<Response>(resolve => { respond = resolve })
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => result)
    vi.stubGlobal('fetch', fetcher)
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice-review')
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (active: boolean) => act(async () => root!.render(
        <DesktopVoiceReview scope={current} draft={draft} take={null} error={null} active={active} />,
    ))
    const bytes = () => new Response(Uint8Array.of(1), { headers: { 'content-type': 'audio/webm' } })
    await render(true)
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Play voice message"]')!
    expect(fetcher).not.toHaveBeenCalled()
    await act(async () => button.click())
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(desktopVoiceAudioReference(original, attemptId), {
        cache: 'no-store', signal: expect.any(AbortSignal),
    })
    const signal = fetcher.mock.calls[0][1]?.signal
    const audio = document.querySelector('audio')!
    if (loaded) {
        await act(async () => respond(bytes()))
        expect(play).toHaveBeenCalledOnce()
        expect(audio.getAttribute('src')).toBe('blob:voice-review')
    }

    await render(false)
    expect(button.disabled).toBe(true)
    expect(audio.getAttribute('src')).toBeNull()
    if (loaded) {
        expect(pause).toHaveBeenCalled()
        expect(revoke).toHaveBeenCalledWith('blob:voice-review')
    } else {
        expect(signal?.aborted).toBe(true)
        await act(async () => respond(bytes()))
        expect(play).not.toHaveBeenCalled()
    }
    await render(true)
    expect(button.disabled).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
})

it('offers localized setup only for an active draft that needs transcription configuration', async () => {
    const onSetup = vi.fn()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const language = { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) } as const
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    const render = (phase: DesktopVoiceDraft['phase'], active: boolean) => act(async () => root!.render(
        <DesktopLocale initial={language}><form onSubmit={onSubmit}>
            <DesktopVoiceReview scope={current} draft={{ ...draft, phase }} take={null} error="Test message" active={active}
                onOpenTranscriptionSettings={onSetup} />
        </form></DesktopLocale>,
    ))
    const setup = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Configurer la transcription')
    await render('failed', true)
    expect(setup()).toBeUndefined()
    await render('unavailable', false)
    expect(setup()).toBeUndefined()
    await render('unavailable', true)
    const button = setup()
    expect(button?.type).toBe('button')
    await act(async () => button!.click())
    expect(onSetup).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
})
