// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
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
const mp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0xc0, 0, 0, 0, 0])

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

function installFetch() {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push(`${url.pathname}?${url.searchParams}`)
        if (url.pathname.endsWith('/files/audio')) {
            if (url.searchParams.get('path') === 'docs/voice.mp3') return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } })
            return Response.json({ error: 'This audio is damaged and can’t be previewed.' }, { status: 415 })
        }
        if (url.pathname.endsWith('/files/image')) return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
        if (url.pathname.endsWith('/files/read')) return Response.json({ path: url.searchParams.get('path'), content: 'hello notes', size: 11, truncated: false, hash: 'abc' })
        if (url.searchParams.get('path') === 'docs') return Response.json({ path: 'docs', entries: [
            { name: 'notes.md', type: 'file', size: 11, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '4:8' },
            { name: 'voice.mp3', type: 'file', size: mp3.byteLength, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '8:1' },
            { name: 'photo.png', type: 'file', size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '7:1' },
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

test('an existing MP3 opens the original audio controls from the desktop audio route', async () => {
    const calls = installFetch()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const root = await openFiles()
    await click('voice.mp3')
    await flush()

    const audioCall = calls.find(call => call.includes('/files/audio'))
    expect(audioCall).toBeDefined()
    const audioUrl = new URL(audioCall!, 'http://127.0.0.1')
    expect(audioUrl.searchParams.get('path')).toBe('docs/voice.mp3')
    expect(audioUrl.searchParams.get('identity')).toBe('8:1')
    expect(calls.some(call => call.includes('/files/read') && call.includes('voice.mp3'))).toBe(false)
    expect(calls.some(call => call.includes('/files/image') && call.includes('voice.mp3'))).toBe(false)
    const player = document.querySelector<HTMLAudioElement>('[data-testid="file-audio-preview"]')
    expect(player?.hasAttribute('controls')).toBe(true)
    expect(player?.hasAttribute('autoplay')).toBe(false)
    expect(player?.className).toContain('w-full')
    expect(player?.className).toContain('max-w-md')
    expect(player?.getAttribute('src')?.startsWith('blob:')).toBe(true)
    expect(button('Edit')).toBeUndefined()
    expect(button('Download')).toBeUndefined()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()

    await click('Back')
    await flush()
    expect(pause).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).toBeNull()
    await click('notes.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('hello notes')
    await click('Back to folder')
    await flush()
    await click('photo.png')
    await flush()
    expect(calls.some(call => call.includes('/files/image') && call.includes('photo.png'))).toBe(true)
    expect(calls.some(call => call.includes('/files/audio') && call.includes('photo.png'))).toBe(false)
    await click('Back')
    await flush()
    await click('draw.svg')
    await flush()
    expect(calls.some(call => call.includes('/files/audio') && call.includes('draw.svg'))).toBe(false)
    expect(calls.some(call => call.includes('/files/read') && call.includes('draw.svg'))).toBe(true)
    act(() => root.unmount())
})

test('a playback error shows its own sentence and removes the player', async () => {
    installFetch()
    const root = await openFiles()
    await click('voice.mp3')
    await flush()
    const player = document.querySelector<HTMLAudioElement>('[data-testid="file-audio-preview"]')
    expect(player).not.toBeNull()
    await act(async () => { player!.dispatchEvent(new Event('error')) })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This audio can’t be played.')
    expect(document.querySelector('[data-testid="file-audio-preview"]')).toBeNull()
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
    await click('voice.mp3')
    await flush()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).not.toBeNull()
    await act(async () => { root.render(<DesktopCoworkerFiles agent={{ ...coworker, id: 'bob', name: 'Bob' }} />) })
    await flush()
    expect(pause).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('a read failure shows the server sentence and no player', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/files/audio')) return Response.json({ error: 'This audio is damaged and can’t be previewed.' }, { status: 415 })
        return Response.json({ path: '', entries: [{ name: 'voice.mp3', type: 'file', size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '1:1' }] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('voice.mp3')
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This audio is damaged and can’t be previewed.')
    expect(document.querySelector('[data-testid="file-audio-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    act(() => root.unmount())
})
