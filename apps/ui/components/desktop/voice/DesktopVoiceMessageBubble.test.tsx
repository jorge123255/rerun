// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '@/lib/desktop/locale'
import { DesktopLocale } from '../DesktopLocale'
import { DesktopVoiceMessageBubble } from './DesktopVoiceMessageBubble'
import { desktopVoiceAudioReference } from '@/lib/desktop/voice/voice'

const scope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'session-1' }
const attemptId = '11111111-1111-4111-8111-111111111111'
let root: Root | undefined

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

it('loads only the exact saved audio reference on Play and never transcribes or sends from history', async () => {
    const fetcher = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'audio/webm' } }))
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const src = desktopVoiceAudioReference(scope, attemptId)
    await act(async () => root!.render(<DesktopVoiceMessageBubble scope={scope} src={src} durationMs={1200} peaks={[0, 0.5, 1]} transcript="saved transcript" />))
    expect(fetcher).not.toHaveBeenCalled()

    await act(async () => {
        const play = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Play voice message')!
        play.click()
    })
    expect(fetcher).toHaveBeenCalledWith(src, { cache: 'no-store', signal: expect.any(AbortSignal) })

    await act(async () => {
        const transcript = [...document.querySelectorAll('button')].find(button => button.textContent === 'Transcript')!
        transcript.click()
    })
    expect(document.body.textContent).toContain('saved transcript')
})

it('refuses a remote or different-owner history reference', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopVoiceMessageBubble scope={scope} src="https://example.com/audio.webm" durationMs={1200} peaks={[]} transcript="saved" />))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('unavailable')
    expect(fetcher).not.toHaveBeenCalled()
})

it('uses the workspace language and enables keyboard seeking only after loading the exact recording', async () => {
    const language = { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) } as const
    const fetcher = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'audio/webm' } }))
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const src = desktopVoiceAudioReference(scope, attemptId)
    const render = (active: boolean) => act(async () => root!.render(<DesktopLocale initial={language}>
        <DesktopVoiceMessageBubble scope={scope} src={src} durationMs={2000} peaks={[]} transcript="Texte enregistré" active={active} />
    </DesktopLocale>))
    await render(true)
    const play = document.querySelector<HTMLButtonElement>('button[aria-label="Écouter le message vocal"]')
    const seek = document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Avancer"]')
    expect(play).not.toBeNull()
    expect(seek?.disabled).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()

    await act(async () => play!.click())
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(src, { cache: 'no-store', signal: expect.any(AbortSignal) })
    expect(seek?.disabled).toBe(true)
    const audio = document.querySelector('audio')!
    await act(async () => audio.dispatchEvent(new Event('loadedmetadata')))
    expect(seek?.disabled).toBe(false)
    expect(seek?.max).toBe('2000')
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(seek, '800')
        seek!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(audio.currentTime).toBe(0.8)

    await render(false)
    expect(seek?.disabled).toBe(true)
    expect(audio.getAttribute('src')).toBeNull()
})

it('cancels an in-flight playback read when the chat becomes inactive', async () => {
    let complete!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { complete = resolve })
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending)
    vi.stubGlobal('fetch', fetcher)
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const src = desktopVoiceAudioReference(scope, attemptId)
    const render = (active: boolean) => act(async () => root!.render(<DesktopVoiceMessageBubble
        scope={scope} src={src} durationMs={1200} peaks={[]} transcript="Saved transcript" active={active} />))
    await render(true)
    const player = document.querySelector<HTMLButtonElement>('button[aria-label="Play voice message"]')!
    await act(async () => player.click())
    const signal = fetcher.mock.calls[0][1]?.signal
    expect(signal?.aborted).toBe(false)
    await render(false)
    expect(signal?.aborted).toBe(true)
    await act(async () => complete(new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'audio/webm' } })))
    expect(player.disabled).toBe(true)
    expect(createUrl).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
})
