// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopVoiceTranscriptActions } from './DesktopVoiceTranscriptActions'
import { interaction } from '@/lib/desktop/chat-interactions/fixtures'
import type { SavedVoiceAlignment } from '@/lib/desktop/chat-interactions/voice'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })
const voice = { transcript: 'Café 👋', src: '/saved/unchanged-audio', durationMs: 2000, peaks: [] }
test('real action controls copy exact saved transcript, remain non-submit, and reset feedback on a different message', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    dispose = async () => { await act(async () => root.unmount()) }
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } })
    const setData = vi.fn()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => {
        const event = new Event('copy', { cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: { setData } }); document.dispatchEvent(event); return true
    }) })
    let current = interaction
    const render = () => root.render(<DesktopVoiceTranscriptActions identity={current} current={() => current} voice={voice} active elapsedMs={0} playing={false} />)
    await act(async () => render())
    const copy = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Copy transcript'))!
    await act(async () => copy.click())
    expect(setData).toHaveBeenCalledWith('text/plain', voice.transcript)
    expect(host.textContent).toContain('Copied!')
    expect([...host.querySelectorAll('button')].every(b => b.type === 'button')).toBe(true)
    current = { ...interaction, messageId: 'same-text-other-message' }
    await act(async () => render())
    expect(host.textContent).toContain('Copy transcript'); expect(host.textContent).not.toContain('Copied!')
    expect(host.querySelector('audio')).toBeNull() // Existing mounted player alone owns audio.
})
test('actual alignment drives heard state; missing metadata after remount restores plain text and stale controls refuse copy', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    dispose = async () => { await act(async () => root.unmount()) }
    const metadata: SavedVoiceAlignment = { identity: interaction, src: voice.src, alignment: {
        version: 1, source: 'alignment', provenance: 'fixture', transcript: voice.transcript, durationMs: voice.durationMs,
        words: [{ text: 'Café', startMs: 300, endMs: 600 }, { text: '👋', startMs: 1200, endMs: 1500 }],
    } }
    await act(async () => root.render(<DesktopVoiceTranscriptActions identity={interaction} current={() => interaction} voice={voice} active elapsedMs={700} playing alignment={metadata} defaultTranscriptOpen />))
    expect(host.querySelector('[data-heard="true"]')?.textContent).toBe('Café')
    expect(host.querySelector('[data-heard="false"]')?.textContent).toBe('👋')
    await act(async () => root.render(<DesktopVoiceTranscriptActions key="restored" identity={interaction} current={() => ({ ...interaction, workspaceId: 2 })} voice={voice} active elapsedMs={700} playing={false} defaultTranscriptOpen />))
    expect(host.querySelector('[data-heard]')).toBeNull(); expect(host.querySelector('p')?.textContent).toBe(voice.transcript)
    const copyCommand = vi.fn(); Object.defineProperty(document, 'execCommand', { configurable: true, value: copyCommand })
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Copy transcript'))!.click())
    expect(copyCommand).not.toHaveBeenCalled()
})
