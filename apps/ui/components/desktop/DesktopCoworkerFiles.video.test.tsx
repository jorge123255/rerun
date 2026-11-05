// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
import { composerTestPng } from '@/lib/desktop/server/composer-image.test-fixtures'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'

vi.mock('@/components/files/FileTextEditor', () => ({
    FileTextEditor: ({ value, onChange, fileName, readOnly }: FileCodeMirrorProps) => <textarea
        aria-label={`Edit ${fileName}`} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const click = async (name: string) => {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mp4 = Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70])
const png = composerTestPng()

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

function installFetch() {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push(`${url.pathname}?${url.searchParams}`)
        if (url.pathname.endsWith('/files/video')) {
            if (url.searchParams.get('path') === 'docs/clip.mp4') return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
            return Response.json({ error: 'This video is damaged and can’t be previewed.' }, { status: 415 })
        }
        if (url.pathname.endsWith('/files/audio')) return new Response(Uint8Array.from([0xff, 0xfb, 0x90, 0xc0]), { headers: { 'content-type': 'audio/mpeg' } })
        if (url.pathname.endsWith('/files/image')) return new Response(new Uint8Array(png).buffer, { headers: { 'content-type': 'image/png' } })
        if (url.pathname.endsWith('/files/read')) return Response.json({ path: url.searchParams.get('path'), content: 'hello notes', size: 11, truncated: false, hash: 'abc' })
        if (url.searchParams.get('path') === 'docs') return Response.json({ path: 'docs', entries: [
            { name: 'notes.md', type: 'file', size: 11, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '4:8' },
            { name: 'clip.mp4', type: 'file', size: mp4.byteLength, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '9:1' },
            { name: 'voice.mp3', type: 'file', size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '8:1' },
            { name: 'photo.png', type: 'file', size: png.byteLength, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '7:1' },
            { name: 'draw.svg', type: 'file', size: 12, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '7:2' },
        ] })
        return Response.json({ path: '', entries: [{ name: 'docs', type: 'dir', size: 0, modifiedAt: '2026-11-04T00:00:00.000Z' }] })
    }))
    return calls
}

async function openFiles() {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('docs')
    await flush()
    return root
}

test('an existing MP4 opens the original video controls from the desktop video route', async () => {
    const calls = installFetch()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const root = await openFiles()
    await click('clip.mp4')
    await flush()

    const videoCall = calls.find(call => call.includes('/files/video'))
    expect(videoCall).toBeDefined()
    const videoUrl = new URL(videoCall!, 'http://127.0.0.1')
    expect(videoUrl.searchParams.get('path')).toBe('docs/clip.mp4')
    expect(videoUrl.searchParams.get('identity')).toBe('9:1')
    expect(calls.some(call => call.includes('/files/read') && call.includes('clip.mp4'))).toBe(false)
    expect(calls.some(call => call.includes('/files/image') && call.includes('clip.mp4'))).toBe(false)
    expect(calls.some(call => call.includes('/files/audio') && call.includes('clip.mp4'))).toBe(false)
    const player = document.querySelector<HTMLVideoElement>('[data-testid="file-video-preview"]')
    expect(player?.hasAttribute('controls')).toBe(true)
    expect(player?.hasAttribute('autoplay')).toBe(false)
    expect(player?.className).toContain('max-h-full')
    expect(player?.className).toContain('max-w-full')
    expect(player?.parentElement?.className).toContain('overflow-auto')
    expect(player?.parentElement?.className).toContain('bg-muted')
    expect(player?.getAttribute('src')?.startsWith('blob:')).toBe(true)
    expect(button('Edit')).toBeUndefined()
    expect(button('Download')).toBeUndefined()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).toBeNull()

    await click('Back')
    await flush()
    expect(pause).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="file-video-preview"]')).toBeNull()
    await click('notes.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('hello notes')
    await click('Back to folder')
    await flush()
    await click('photo.png')
    await flush()
    expect(calls.some(call => call.includes('/files/image') && call.includes('photo.png'))).toBe(true)
    expect(calls.some(call => call.includes('/files/video') && call.includes('photo.png'))).toBe(false)
    await click('Back')
    await flush()
    await click('voice.mp3')
    await flush()
    expect(calls.some(call => call.includes('/files/audio') && call.includes('voice.mp3'))).toBe(true)
    expect(calls.some(call => call.includes('/files/video') && call.includes('voice.mp3'))).toBe(false)
    await click('Back')
    await flush()
    await click('draw.svg')
    await flush()
    expect(calls.some(call => call.includes('/files/video') && call.includes('draw.svg'))).toBe(false)
    expect(calls.some(call => call.includes('/files/read') && call.includes('draw.svg'))).toBe(false)
    expect(calls.some(call => call.includes('/files/image') && call.includes('draw.svg'))).toBe(true)
    expect(document.querySelector('[data-testid="file-image-preview"]')?.getAttribute('alt')).toBe('draw.svg')
    act(() => root.unmount())
})

test('a playback error shows its own sentence and removes the player', async () => {
    installFetch()
    const root = await openFiles()
    await click('clip.mp4')
    await flush()
    const player = document.querySelector<HTMLVideoElement>('[data-testid="file-video-preview"]')
    expect(player).not.toBeNull()
    await act(async () => { player!.dispatchEvent(new Event('error')) })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This video can’t be played.')
    expect(document.querySelector('[data-testid="file-video-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('closing Files for another coworker stops playback', async () => {
    installFetch()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('docs')
    await flush()
    await click('clip.mp4')
    await flush()
    expect(document.querySelector('[data-testid="file-video-preview"]')).not.toBeNull()
    await act(async () => { root.render(<DesktopCoworkerFiles agent={{ ...coworker, id: 'bob', name: 'Bob' }} />) })
    await flush()
    expect(pause).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="file-video-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('a read failure shows the server sentence and no player', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/files/video')) return Response.json({ error: 'This video is damaged and can’t be previewed.' }, { status: 415 })
        return Response.json({ path: '', entries: [{ name: 'clip.mp4', type: 'file', size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '1:1' }] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('clip.mp4')
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This video is damaged and can’t be previewed.')
    expect(document.querySelector('[data-testid="file-video-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    act(() => root.unmount())
})
