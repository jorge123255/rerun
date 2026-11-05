// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopFileVideoPreview } from './DesktopFileVideoPreview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const fetchMock = vi.fn()
let objectUrls = 0

beforeEach(() => {
    objectUrls = 0
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:video-${++objectUrls}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function mount(name: string, response: Response, path = `docs/${name}`) {
    fetchMock.mockResolvedValue(response)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const srcUrl = `/api/desktop/agents/agent-a/files/video?${new URLSearchParams({ path, identity: '9:1' })}`
    await act(async () => {
        root?.render(<DesktopFileVideoPreview name={name} path={path} identity="9:1" srcUrl={srcUrl} onBack={() => {}} />)
    })
    await act(async () => {})
    return container
}

test.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.webm', 'video/webm'],
    ['clip.mov', 'video/quicktime'],
    ['clip.m4v', 'video/mp4'],
])('plays %s served as %s through the original controls', async (name, type) => {
    const container = await mount(name, new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': type } }))
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video!.hasAttribute('controls')).toBe(true)
    expect(video!.getAttribute('src')).toMatch(/^blob:video-/)
    expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('a refused or wrong-type response shows the route error instead of a player', async () => {
    const container = await mount('clip.webm', Response.json({ error: 'This video format can’t be previewed.' }, { status: 415 }))
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This video format can’t be previewed.')
})

test('an undecodable stream keeps a visible error state', async () => {
    const container = await mount('clip.mov', new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/quicktime' } }))
    const video = container.querySelector('video')!
    await act(async () => { video.dispatchEvent(new Event('error')) })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This video can’t be played.')
    expect(container.querySelector('video')).toBeNull()
})
