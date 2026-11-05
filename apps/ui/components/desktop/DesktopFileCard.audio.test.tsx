// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileCard, FileCardEntry } from '@rerun/contracts'
import { DesktopFileCard } from './DesktopFileCard'
import { DesktopFileLightbox } from './DesktopFileLightbox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots = new Set<Root>()
afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount())
    roots.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

const audio = (): FileCardEntry => ({ path: 'voice/tone.wav', name: 'tone.wav', size: 1024, scope: 'agent', identity: '8:1' })
const text = (): FileCardEntry => ({ path: 'notes.md', name: 'notes.md', size: 10, scope: 'agent' })
const cardOf = (files: FileCardEntry[]): FileCard => ({ kind: 'file', files })
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

function mount() {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.add(root)
    return root
}

async function click(label: string) {
    const node = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label)
    expect(node, label).toBeDefined()
    await act(async () => { node!.click() })
    await flush()
}

function objectUrls() {
    let sequence = 0
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:card-audio-${++sequence}`)
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return { create, revoke }
}

const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])

function audioFetch(reply: (path: string) => Response | Promise<Response>) {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push(`${url.pathname.split('/').at(-1)}:${url.searchParams.get('path')}`)
        expect(init).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) })
        return reply(url.searchParams.get('path')!)
    }))
    return calls
}

test('audio tiles are inert until opened, then play from the original controls without a Files header', async () => {
    const urls = objectUrls()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const calls = audioFetch(path => path.endsWith('.wav')
        ? new Response(new Blob([wav], { type: 'audio/wav' }), { headers: { 'content-type': 'audio/wav' } })
        : Response.json({ content: 'Current notes', truncated: false }))
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf([audio(), text()])} />))
    await flush()

    expect(calls).toEqual([])
    expect(document.querySelector('[data-file-card] audio')).toBeNull()
    await click('Open tone.wav')
    expect(calls).toEqual(['audio:voice/tone.wav'])
    const player = dialog()?.querySelector<HTMLAudioElement>('audio')
    expect(player).not.toBeNull()
    expect(player?.hasAttribute('controls')).toBe(true)
    expect(player?.hasAttribute('autoplay')).toBe(false)
    expect(player?.getAttribute('src')).toMatch(/^blob:/)
    expect(player?.getAttribute('data-testid')).toBe('card-audio-preview')
    expect(dialog()?.querySelectorAll('h2')).toHaveLength(1)
    expect(dialog()?.textContent).not.toContain('Files')
    expect(dialog()?.querySelector('a[download], iframe, video')).toBeNull()
    const audioUrl = player?.getAttribute('src')

    await click('Next attachment')
    expect(calls).toEqual(['audio:voice/tone.wav', 'read:notes.md'])
    expect(dialog()?.querySelector('pre')?.textContent).toBe('Current notes')
    expect(dialog()?.querySelector('audio')).toBeNull()
    expect(pause).toHaveBeenCalled()
    expect(urls.revoke).toHaveBeenCalledWith(audioUrl)

    await click('Previous attachment')
    expect(calls).toEqual(['audio:voice/tone.wav', 'read:notes.md', 'audio:voice/tone.wav'])
    const secondUrl = dialog()?.querySelector('audio')?.getAttribute('src')
    expect(secondUrl).toMatch(/^blob:/)
    expect(secondUrl).not.toBe(audioUrl)
    await click('Close')
    expect(dialog()).toBeNull()
    expect(pause).toHaveBeenCalled()
    expect(urls.revoke).toHaveBeenCalledWith(secondUrl)
})

test('a replaced or invalid audio file shows an explicit error instead of an audio player', async () => {
    objectUrls()
    audioFetch(() => Response.json({ error: '“tone.wav” was renamed or replaced. It was left unchanged.' }, { status: 409 }))
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf([audio()])} />))
    await flush()
    await click('Open tone.wav')
    expect(dialog()?.querySelector('audio')).toBeNull()
    expect(dialog()?.textContent).toContain('renamed or replaced')
    expect(dialog()?.querySelector('a[download]')).toBeNull()
    await click('Close')
})

test('a playback error removes the player and releases its object URL', async () => {
    const urls = objectUrls()
    audioFetch(() => new Response(new Blob([wav], { type: 'audio/wav' }), { headers: { 'content-type': 'audio/wav' } }))
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf([audio()])} />))
    await flush()
    await click('Open tone.wav')
    const player = dialog()!.querySelector<HTMLAudioElement>('audio')!
    const url = player.getAttribute('src')
    await act(async () => { player.dispatchEvent(new Event('error')) })
    expect(dialog()?.querySelector('audio')).toBeNull()
    expect(dialog()?.textContent).toContain('This audio can’t be played.')
    expect(urls.revoke).toHaveBeenCalledWith(url)
})

test('paging and owner changes abort old audio reads and never show their late player', async () => {
    objectUrls()
    const pending = new Map<string, (response: Response) => void>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        if (url.pathname.endsWith('/files/read')) return Response.json({ content: 'notes', truncated: false })
        expect(url.pathname).toMatch(/^\/api\/desktop\/agents\/[^/]+\/files\/audio$/)
        const owner = decodeURIComponent(url.pathname.split('/')[4]!)
        return new Promise<Response>(resolve => { pending.set(`${owner}:${url.searchParams.get('path')}`, resolve) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = mount()
    const files = [audio(), text()]
    const render = (owner: string, index: number) => act(async () => root.render(
        <DesktopFileLightbox agentId={owner} files={files} index={index} onIndexChange={() => {}} onClose={() => {}} />,
    ))
    await render('alpha', 0)
    expect(pending.size).toBe(1)
    const alphaSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal
    await render('alpha', 1)
    await flush()
    expect(dialog()?.querySelector('pre')?.textContent).toBe('notes')
    expect(alphaSignal?.aborted).toBe(true)
    await act(async () => { pending.get('alpha:voice/tone.wav')!(new Response(new Blob([wav], { type: 'audio/wav' }), { headers: { 'content-type': 'audio/wav' } })) })
    await flush()
    expect(dialog()?.querySelector('audio')).toBeNull()
    await render('bravo', 0)
    expect(pending.size).toBe(2)
    const bravoSignal = (fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.signal
    expect(bravoSignal?.aborted).toBe(false)
    await act(async () => { pending.get('bravo:voice/tone.wav')!(new Response(new Blob([wav], { type: 'audio/wav' }), { headers: { 'content-type': 'audio/wav' } })) })
    await flush()
    expect(dialog()?.querySelector('audio')).not.toBeNull()
    await act(async () => root.unmount())
    roots.delete(root)
    expect(bravoSignal?.aborted).toBe(true)
})


test('new audio formats keep original inert waveform tiles and lazy player cleanup when paged', async () => {
    const urls = objectUrls()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const formats = [['m4a', 'audio/mp4'], ['ogg', 'audio/ogg'], ['flac', 'audio/flac']]
    const calls = audioFetch(path => {
        const mime = formats.find(([ext]) => path.endsWith(`.${ext}`))![1]!
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': mime } })
    })
    const root = mount()
    const files = formats.map(([ext]) => ({ ...audio(), path: `voice/tone.${ext}`, name: `tone.${ext}` }))
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf(files)} />))
    await flush()
    expect(calls).toEqual([])
    expect(document.querySelectorAll('[data-file-card] audio')).toHaveLength(0)
    await click('Open tone.m4a')
    for (let index = 0; index < formats.length; index++) {
        const player = dialog()?.querySelector<HTMLAudioElement>('audio')
        expect(player).not.toBeNull()
        expect(player?.hasAttribute('controls')).toBe(true)
        expect(player?.hasAttribute('autoplay')).toBe(false)
        expect(calls).toHaveLength(index + 1)
        const url = player!.getAttribute('src')
        if (index < formats.length - 1) await click('Next attachment')
        else await click('Close')
        expect(urls.revoke).toHaveBeenCalledWith(url)
    }
    expect(calls).toEqual(['audio:voice/tone.m4a', 'audio:voice/tone.ogg', 'audio:voice/tone.flac'])
    expect(pause).toHaveBeenCalled()
    expect(dialog()).toBeNull()
})
