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

const image = (n: number): FileCardEntry => ({ path: `shots/${n}.png`, name: `${n}.png`, size: 1024, scope: 'agent', identity: `1:${n}` })
const textFile = (name = 'notes.md'): FileCardEntry => ({ path: name, name, size: 10, scope: 'agent' })
const cardOf = (files: FileCardEntry[]): FileCard => ({ kind: 'file', files })
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
const imageResponse = (size?: number) => new Response(size ? new Uint8Array(size) : png, { headers: { 'content-type': 'image/png' } })

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
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:card-image-${++sequence}`)
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

type ImageRequest = { owner: string; path: string; signal: AbortSignal }
function imageReads(reply: (request: ImageRequest) => Response | Promise<Response>) {
    const requests: ImageRequest[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const match = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/files\/image$/)
        expect(match).not.toBeNull()
        expect(init).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) })
        const path = url.searchParams.get('path')!
        const n = path.match(/(\d+)\.png$/)?.[1]
        expect(url.searchParams.get('identity')).toBe(`1:${n}`)
        const request = { owner: decodeURIComponent(match![1]), path, signal: init!.signal as AbortSignal }
        requests.push(request)
        return reply(request)
    }))
    return requests
}

test('an album fetches four visible thumbnails and pages into its hidden files in original order', async () => {
    const urls = objectUrls()
    const requests = imageReads(() => imageResponse())
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="owner a" card={cardOf(Array.from({ length: 6 }, (_, i) => image(i + 1)))} />))
    await flush()

    expect(requests.map(request => request.path)).toEqual(['shots/1.png', 'shots/2.png', 'shots/3.png', 'shots/4.png'])
    expect(requests.every(request => request.owner === 'owner a')).toBe(true)
    expect(document.querySelectorAll('[data-file-card] figure')).toHaveLength(4)
    expect([...document.querySelectorAll('figcaption')].map(node => node.textContent)).toEqual(['1.png', '2.png', '3.png', '4.png'])
    expect(document.querySelector('button[aria-label="Open 2 more"]')?.textContent?.trim()).toBe('+2')

    await click('Open 2 more')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('4.png')
    expect(dialog()?.textContent).toContain('4 / 6')
    const fourthUrl = dialog()?.querySelector('img')?.getAttribute('src')
    expect(fourthUrl).toMatch(/^blob:/)
    await click('Next attachment')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('5.png')
    expect(dialog()?.textContent).toContain('5 / 6')
    expect(urls.revoke).toHaveBeenCalledWith(fourthUrl)
    await click('Next attachment')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('6.png')
    await click('Next attachment')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('1.png')
    expect(requests.map(request => request.path)).toEqual([
        'shots/1.png', 'shots/2.png', 'shots/3.png', 'shots/4.png',
        'shots/4.png', 'shots/5.png', 'shots/6.png', 'shots/1.png',
    ])
    expect(document.querySelector('a[download], iframe, audio, video')).toBeNull()
    await click('Close')
    await unmount(root)
    expect(new Set(urls.revoke.mock.calls.map(([url]) => url))).toEqual(new Set(urls.create.mock.results.map(result => result.value)))
})

test('mixed cards keep document and image order and release the image when paging back to text', async () => {
    const urls = objectUrls()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        expect(url.pathname).toMatch(/^\/api\/desktop\/agents\/mixed-owner\/files\/(image|read)$/)
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        calls.push(`${url.pathname.split('/').at(-1)}:${url.searchParams.get('path')}`)
        if (url.pathname.endsWith('/image')) return imageResponse()
        return Response.json({ content: `Current ${url.searchParams.get('path')}`, truncated: false })
    }))
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="mixed-owner" card={cardOf([textFile(), image(2), textFile('last.txt')])} />))
    await flush()
    expect([...document.querySelectorAll('button[aria-label^="Open "]')].map(node => node.getAttribute('aria-label')))
        .toEqual(['Open notes.md', 'Open 2.png', 'Open last.txt'])
    expect(document.querySelector('figure')).toBeNull()
    expect(calls).toEqual(['image:shots/2.png'])
    await click('Open notes.md')
    expect(dialog()?.querySelector('pre')?.textContent).toBe('Current notes.md')
    await click('Next attachment')
    const lightboxUrl = dialog()?.querySelector('img')?.getAttribute('src')
    expect(lightboxUrl).toMatch(/^blob:/)
    expect(dialog()?.querySelector('pre')).toBeNull()
    await click('Next attachment')
    expect(dialog()?.querySelector('pre')?.textContent).toBe('Current last.txt')
    expect(dialog()?.querySelector('img')).toBeNull()
    expect(urls.revoke).toHaveBeenCalledWith(lightboxUrl)
    expect(calls).toEqual(['image:shots/2.png', 'read:notes.md', 'image:shots/2.png', 'read:last.txt'])
})

test('a delayed thumbnail cannot cross owners or create a URL after unmount', async () => {
    const urls = objectUrls()
    const pending: ((response: Response) => void)[] = []
    const requests = imageReads(request => request.owner === 'alpha'
        ? new Promise(resolve => { pending.push(resolve) })
        : imageResponse())
    const card = cardOf([image(1)])
    const root = mount()
    await act(async () => root.render(<DesktopFileCard agentId="alpha" card={card} />))
    expect(pending).toHaveLength(1)
    await act(async () => root.render(<DesktopFileCard agentId="bravo" card={card} />))
    await flush()
    expect(requests[0].signal.aborted).toBe(true)
    const bravoUrl = document.querySelector('[data-file-card] img')?.getAttribute('src')
    expect(bravoUrl).toMatch(/^blob:/)
    await act(async () => pending[0](imageResponse()))
    await flush()
    expect(document.querySelector('[data-file-card] img')?.getAttribute('src')).toBe(bravoUrl)
    expect(urls.create).toHaveBeenCalledTimes(1)

    await act(async () => root.render(<DesktopFileCard agentId="alpha" card={card} />))
    expect(urls.revoke).toHaveBeenCalledWith(bravoUrl)
    expect(document.querySelector('[data-file-card] img')).toBeNull()
    expect(pending).toHaveLength(2)
    await unmount(root)
    expect(requests[2].signal.aborted).toBe(true)
    await act(async () => pending[1](imageResponse()))
    await flush()
    expect(urls.create).toHaveBeenCalledTimes(1)
})

test('lightbox paging and owner changes abort old reads and never display their late images', async () => {
    const urls = objectUrls()
    const pending = new Map<string, (response: Response) => void>()
    const requests = imageReads(request => request.owner === 'alpha' && request.path === 'shots/2.png'
        ? imageResponse()
        : new Promise(resolve => { pending.set(`${request.owner}:${request.path}`, resolve) }))
    const root = mount()
    const files = [image(1), image(2)]
    const render = (owner: string, index: number) => act(async () => root.render(
        <DesktopFileLightbox agentId={owner} files={files} index={index} onIndexChange={() => {}} onClose={() => {}} />,
    ))
    await render('alpha', 0)
    await render('alpha', 1)
    await flush()
    const alphaUrl = dialog()?.querySelector('img')?.getAttribute('src')
    expect(alphaUrl).toMatch(/^blob:/)
    expect(requests[0].signal.aborted).toBe(true)
    await act(async () => pending.get('alpha:shots/1.png')!(imageResponse()))
    await flush()
    expect(dialog()?.querySelector('h2')?.textContent).toBe('2.png')
    expect(dialog()?.querySelector('img')?.getAttribute('src')).toBe(alphaUrl)
    expect(urls.create).toHaveBeenCalledTimes(1)

    await render('bravo', 1)
    expect(urls.revoke).toHaveBeenCalledWith(alphaUrl)
    expect(dialog()?.querySelector('img')).toBeNull()
    await act(async () => pending.get('bravo:shots/2.png')!(imageResponse()))
    await flush()
    const bravoUrl = dialog()?.querySelector('img')?.getAttribute('src')
    expect(bravoUrl).toMatch(/^blob:/)
    expect(bravoUrl).not.toBe(alphaUrl)
    await unmount(root)
    expect(urls.revoke).toHaveBeenCalledWith(bravoUrl)
    expect(requests[2].signal.aborted).toBe(true)
})

test('mixed cards inspect only four previews and refuse corrupt returned bytes', async () => {
    const urls = objectUrls()
    const requests = imageReads(() => imageResponse(CARD_MAX_IMAGE_BYTES))
    const root = mount()
    // The fifth mixed image stays lazy, and malformed bytes never become object URLs.
    await act(async () => root.render(<DesktopFileCard agentId="budget-owner" card={cardOf([
        textFile(), ...Array.from({ length: 5 }, (_, i) => image(i + 1)),
    ])} />))
    await flush()
    expect(requests.map(request => request.path)).toEqual(['shots/1.png', 'shots/2.png', 'shots/3.png', 'shots/4.png'])
    expect(urls.create).toHaveBeenCalledTimes(0)
    expect(document.querySelectorAll('[data-file-card] img')).toHaveLength(0)
    expect([...document.querySelectorAll('button')].filter(node => node.textContent?.trim() === 'Image unavailable')).toHaveLength(4)
    expect(document.querySelector('button[aria-label="Open 5.png"]')?.getAttribute('title')).toContain('Open to preview')
    await unmount(root)
    expect(new Set(urls.revoke.mock.calls.map(([url]) => url))).toEqual(new Set(urls.create.mock.results.map(result => result.value)))
})
