// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
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
        const transcript = [...document.querySelectorAll('button')].find(button => button.textContent === 'Show transcript')!
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
