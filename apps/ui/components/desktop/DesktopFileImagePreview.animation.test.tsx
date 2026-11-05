// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopFileImagePreview } from './DesktopFileImagePreview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const gif = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
const descriptor = gif.indexOf(0x2c)
const animated = new Uint8Array(gif.length - 1 + (gif.length - descriptor))
animated.set(gif.subarray(0, gif.length - 1), 0)
animated.set(gif.subarray(descriptor), gif.length - 1)

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const srcFor = (path: string) => `/api/desktop/agents/alice/files/image?path=${encodeURIComponent(path)}&identity=7%3A1`

let root: Root | null = null
afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('an animated GIF stays the whole file in the image frame and does not start audio or video', async () => {
    const calls: string[] = []
    const blobs: Blob[] = []
    const create = URL.createObjectURL.bind(URL)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(value => {
        blobs.push(value as Blob)
        return create(value as Blob)
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return new Response(animated, { headers: { 'content-type': 'image/gif' } })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root!.render(<DesktopFileImagePreview name="loop.gif" path="docs/loop.gif" identity="7:1" srcUrl={srcFor('docs/loop.gif')} onBack={() => {}} />) })
    await flush()

    const url = new URL(calls[0]!, 'http://127.0.0.1')
    expect(url.pathname).toBe('/api/desktop/agents/alice/files/image')
    expect(url.searchParams.get('path')).toBe('docs/loop.gif')
    expect(url.searchParams.get('identity')).toBe('7:1')
    expect(url.searchParams.get('animation')).toBe('1')
    expect(calls).toHaveLength(1)
    const img = document.querySelector<HTMLImageElement>('[data-testid="file-image-preview"]')
    expect(img?.getAttribute('alt')).toBe('loop.gif')
    expect(img?.className).toContain('object-contain')
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(animated)
    expect(animated.filter(byte => byte === 0x2c)).toHaveLength(2)
    expect(document.querySelector('video, audio, canvas')).toBeNull()

    act(() => root!.unmount())
    root = null
    await act(async () => {
        const again = document.createElement('div')
        document.body.append(again)
        root = createRoot(again)
        root.render(<DesktopFileImagePreview name="loop.gif" path="docs/loop.gif" identity="7:1" srcUrl={srcFor('docs/loop.gif')} onBack={() => {}} />)
    })
    await flush()
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1]!, 'http://127.0.0.1').searchParams.get('path')).toBe('docs/loop.gif')
    expect(document.querySelector('[data-testid="file-image-preview"]')?.getAttribute('alt')).toBe('loop.gif')
    expect(document.querySelector('video, audio, canvas')).toBeNull()
})

test('a refused animation stays visible as the server error and a closed preview aborts the read', async () => {
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init!.signal!)
        return Response.json({ error: 'This animation has too many frames to preview.' }, { status: 413 })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root!.render(<DesktopFileImagePreview name="many.gif" path="docs/many.gif" identity="7:1" srcUrl={srcFor('docs/many.gif')} onBack={() => {}} />) })
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This animation has too many frames to preview.')
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    expect(document.querySelector('video, audio, canvas')).toBeNull()

    let hung: AbortSignal | null = null
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        hung = init!.signal!
        return new Promise(() => {})
    }))
    await act(async () => { root!.render(<DesktopFileImagePreview name="other.gif" path="docs/other.gif" identity="7:1" srcUrl={srcFor('docs/other.gif')} onBack={() => {}} />) })
    expect(signals[0]?.aborted).toBe(true)
    act(() => root!.unmount())
    root = null
    expect(hung?.aborted).toBe(true)
})
