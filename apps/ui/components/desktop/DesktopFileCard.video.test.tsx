// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { CARD_MAX_IMAGE_BYTES, type FileCard, type FileCardEntry } from '@rerun/contracts'
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

const video = (n: number): FileCardEntry => ({ path: `clips/${n}.mp4`, name: `${n}.mp4`, size: 1024, scope: 'agent', identity: `2:${n}` })
const image = (n: number): FileCardEntry => ({ path: `shots/${n}.png`, name: `${n}.png`, size: 1024, scope: 'agent', identity: `1:${n}` })
const textFile = (name = 'notes.md'): FileCardEntry => ({ path: name, name, size: 10, scope: 'agent' })
const cardOf = (files: FileCardEntry[]): FileCard => ({ kind: 'file', files })
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const videoResponse = (size = 8) => new Response(new Uint8Array(size), { headers: { 'content-type': 'video/mp4' } })
const imageResponse = (size = 4) => new Response(new Uint8Array(size), { headers: { 'content-type': 'image/png' } })

function mount() {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.add(root)
    return root
}

async function unmount(root: Root) {
    await act(async () => root.unmount())
    roots.delete(root)
}

function objectUrls() {
    let sequence = 0
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:card-video-${++sequence}`)
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return { create, revoke }
}

async function click(label: string) {
    const node = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label)
    expect(node, label).toBeDefined()
    await act(async () => { node!.click() })
    await flush()
}

type MediaRequest = { owner: string; kind: string; path: string; signal: AbortSignal }
function mediaReads(reply: (request: MediaRequest) => Response | Promise<Response>) {
    const requests: MediaRequest[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const match = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/files\/(video|image|read)$/)
        expect(match).not.toBeNull()
        const kind = match![2]!
        const path = url.searchParams.get('path')!
        if (kind === 'read') return Response.json({ content: `Current ${path}`, truncated: false })
        const n = path.match(/(\d+)\.(?:mp4|png)$/)?.[1]
        expect(url.searchParams.get('identity')).toBe(`${kind === 'video' ? 2 : 1}:${n}`)
        expect(init).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) })
        const request = { owner: decodeURIComponent(match![1]), kind, path, signal: init!.signal as AbortSignal }
        requests.push(request)
        return reply(request)
    }))
    return requests
}

test('an all-video album fetches only four visible first-frame previews and pages into the rest', async () => {
    const urls = objectUrls()
    const requests = mediaReads(() => videoResponse())
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf(Array.from({ length: 6 }, (_, i) => video(i + 1)))} />))
    await flush()

    expect(requests.map(request => request.path)).toEqual(['clips/1.mp4', 'clips/2.mp4', 'clips/3.mp4', 'clips/4.mp4'])
    expect(document.querySelectorAll('[data-file-card] figure')).toHaveLength(4)
    expect([...document.querySelectorAll('figcaption')].map(node => node.textContent)).toEqual(['1.mp4', '2.mp4', '3.mp4', '4.mp4'])
    const tiles = [...document.querySelectorAll<HTMLVideoElement>('[data-file-card] video')]
    expect(tiles).toHaveLength(4)
    expect(tiles.every(tile => tile.hasAttribute('autoplay'))).toBe(false)
    expect(tiles.every(tile => tile.getAttribute('preload') === 'metadata')).toBe(true)
    expect(tiles.map(tile => tile.getAttribute('src'))).toEqual([
        'blob:card-video-1#t=0.1', 'blob:card-video-2#t=0.1', 'blob:card-video-3#t=0.1', 'blob:card-video-4#t=0.1',
    ])
    expect(document.querySelector('button[aria-label="Open 2 more"]')?.textContent?.trim()).toBe('+2')

    await click('Open 2 more')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('4.mp4')
    expect(dialog()?.textContent).toContain('4 / 6')
    const player = dialog()?.querySelector<HTMLVideoElement>('video')
    expect(player).not.toBeNull()
    expect(player?.hasAttribute('controls')).toBe(true)
    expect(player?.hasAttribute('autoplay')).toBe(false)
    expect(player?.getAttribute('data-testid')).toBe('card-video-preview')
    const fourthUrl = player?.getAttribute('src')
    expect(fourthUrl).toMatch(/^blob:/)

    await click('Next attachment')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('5.mp4')
    expect(urls.revoke).toHaveBeenCalledWith(fourthUrl)
    expect(requests.map(request => request.path)).toEqual([
        'clips/1.mp4', 'clips/2.mp4', 'clips/3.mp4', 'clips/4.mp4', 'clips/4.mp4', 'clips/5.mp4',
    ])
    const fifthUrl = dialog()?.querySelector('video')?.getAttribute('src')
    await click('Close')
    expect(dialog()).toBeNull()
    expect(urls.revoke).toHaveBeenCalledWith(fifthUrl)
    await unmount(root)
})

test('mixed cards keep document, image and video order and use the original square video tile', async () => {
    const urls = objectUrls()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const match = url.pathname.match(/^\/api\/desktop\/agents\/mixed-owner\/files\/(video|image|read)$/)
        expect(match).not.toBeNull()
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        calls.push(`${match![1]}:${url.searchParams.get('path')}`)
        if (match![1] === 'video') return videoResponse()
        if (match![1] === 'image') return imageResponse()
        return Response.json({ content: `Current ${url.searchParams.get('path')}`, truncated: false })
    }))
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="mixed-owner" card={cardOf([textFile(), image(2), video(3), textFile('last.txt')])} />))
    await flush()
    expect([...document.querySelectorAll('button[aria-label^="Open "]')].map(node => node.getAttribute('aria-label')))
        .toEqual(['Open notes.md', 'Open 2.png', 'Open 3.mp4', 'Open last.txt'])
    expect(document.querySelector('figure')).toBeNull()
    expect(calls).toEqual(['image:shots/2.png', 'video:clips/3.mp4'])
    expect(document.querySelector('[data-file-card] video')?.getAttribute('src')).toBe('blob:card-video-2#t=0.1')

    await click('Open notes.md')
    expect(dialog()?.querySelector('pre')?.textContent).toBe('Current notes.md')
    await click('Next attachment')
    expect(dialog()?.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
    await click('Next attachment')
    expect(dialog()?.querySelector('video')?.getAttribute('data-testid')).toBe('card-video-preview')
    const videoUrl = dialog()?.querySelector('video')?.getAttribute('src')
    await click('Next attachment')
    expect(dialog()?.querySelector('pre')?.textContent).toBe('Current last.txt')
    expect(dialog()?.querySelector('video')).toBeNull()
    expect(urls.revoke).toHaveBeenCalledWith(videoUrl)
})

test('a replaced or invalid video shows an explicit error instead of a player', async () => {
    objectUrls()
    mediaReads(() => Response.json({ error: '“clip.mp4” was renamed or replaced. It was left unchanged.' }, { status: 409 }))
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf([video(1)])} />))
    await flush()
    expect(document.querySelector('[data-file-card] video')).toBeNull()
    expect(document.querySelector('button[aria-label="Open 1.mp4"]')?.textContent).toContain('renamed or replaced')
    await click('Open 1.mp4')
    expect(dialog()?.querySelector('video')).toBeNull()
    expect(dialog()?.textContent).toContain('renamed or replaced')
    expect(dialog()?.querySelector('a[download]')).toBeNull()
    await click('Close')
})

test('a playback error removes the player and releases its object URL', async () => {
    const urls = objectUrls()
    mediaReads(() => videoResponse())
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf([video(1)])} />))
    await flush()
    await click('Open 1.mp4')
    const player = dialog()?.querySelector<HTMLVideoElement>('video')!
    const url = player.getAttribute('src')
    await act(async () => { player.dispatchEvent(new Event('error')) })
    expect(dialog()?.querySelector('video')).toBeNull()
    expect(dialog()?.textContent).toContain('This video can’t be played.')
    expect(urls.revoke).toHaveBeenCalledWith(url)
})

test('paging, owner changes and unmount stop the player, abort its read and never revive a late video', async () => {
    const urls = objectUrls()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const pending = new Map<string, (response: Response) => void>()
    const requests = mediaReads(request => request.owner === 'alpha' && request.path === 'clips/1.mp4'
        ? videoResponse()
        : new Promise(resolve => { pending.set(`${request.owner}:${request.path}`, resolve) }))
    const root = mount()
    const files = [video(1), image(2)]
    const render = (owner: string, index: number) => act(async () => root.render(
        <DesktopFileLightbox agentId={owner} files={files} index={index} onIndexChange={() => {}} onClose={() => {}} />,
    ))
    await render('alpha', 0)
    await flush()
    const alphaPlayer = dialog()?.querySelector<HTMLVideoElement>('video')!
    const alphaUrl = alphaPlayer.getAttribute('src')
    expect(alphaUrl).toMatch(/^blob:/)

    await render('alpha', 1)
    await flush()
    expect(alphaPlayer.getAttribute('src')).toBeNull()
    expect(pause).toHaveBeenCalled()
    expect(urls.revoke).toHaveBeenCalledWith(alphaUrl)
    expect(requests[0].signal.aborted).toBe(true)

    await render('bravo', 0)
    expect(requests[1].signal.aborted).toBe(false)
    await act(async () => { pending.get('bravo:clips/1.mp4')!(videoResponse()) })
    await flush()
    const bravoPlayer = dialog()?.querySelector<HTMLVideoElement>('video')!
    const bravoUrl = bravoPlayer.getAttribute('src')

    await render('alpha', 0)
    expect(pause).toHaveBeenCalled()
    expect(urls.revoke).toHaveBeenCalledWith(bravoUrl)
    await act(async () => { pending.get('alpha:clips/1.mp4')!(videoResponse()) })
    await flush()
    await unmount(root)
    expect(requests[2].signal.aborted).toBe(true)
})

test('the video tile stops and detaches its element when the card is replaced', async () => {
    const urls = objectUrls()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const requests = mediaReads(() => videoResponse())
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="alpha" card={cardOf([video(1)])} />))
    await flush()
    const tile = document.querySelector<HTMLVideoElement>('[data-file-card] video')!
    const first = tile.getAttribute('src')
    expect(first).toBe('blob:card-video-1#t=0.1')
    await act(async () => root.render(<DesktopFileCard agentId="bravo" card={cardOf([video(1)])} />))
    await flush()
    expect(tile.getAttribute('src')).toBeNull()
    expect(pause).toHaveBeenCalled()
    expect(urls.revoke).toHaveBeenCalledWith(first)
    expect(document.querySelector('[data-file-card] video')?.getAttribute('src')).toBe('blob:card-video-2#t=0.1')
    expect(requests[0].signal.aborted).toBe(true)
    await unmount(root)
})

test('combined image and video previews stop before the 24 MB budget using fetched bytes', async () => {
    const urls = objectUrls()
    const requests = mediaReads(request => request.kind === 'video' ? videoResponse(CARD_MAX_IMAGE_BYTES) : imageResponse(CARD_MAX_IMAGE_BYTES))
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="budget-owner" card={cardOf([
        textFile(), image(1), image(2), image(3), video(4),
    ])} />))
    await flush()
    expect(requests.map(request => `${request.kind}:${request.path}`)).toEqual([
        'image:shots/1.png', 'image:shots/2.png', 'image:shots/3.png',
    ])
    expect(urls.create).toHaveBeenCalledTimes(3)
    expect(document.querySelectorAll('[data-file-card] img')).toHaveLength(3)
    expect(document.querySelector('button[aria-label="Open 4.mp4"]')?.getAttribute('title')).toContain('24 MB')
    await unmount(root)
    expect(new Set(urls.revoke.mock.calls.map(([url]) => url))).toEqual(new Set(urls.create.mock.results.map(result => result.value)))
})
