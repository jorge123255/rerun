// @vitest-environment happy-dom
// @vitest-environment-options {"happyDOM":{"settings":{"disableIframePageLoading":true}}}
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'
import { DESKTOP_PDF_FRAME_CSP } from './DesktopFilePdfPreview'

vi.mock('@/components/files/FileTextEditor', () => ({
    FileTextEditor: ({ value, onChange, fileName, readOnly }: FileCodeMirrorProps) => <textarea
        aria-label={`Edit ${fileName}`} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
const deck = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n')
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const click = async (name: string) => {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

function installFetch(entries?: { name: string; type: 'file' | 'dir'; identity?: string }[]) {
    const calls: string[] = []
    const docs = entries ?? [
        { name: 'alpha.pdf', type: 'file' as const, identity: '3:1' },
        { name: 'notes.md', type: 'file' as const, identity: '4:8' },
        { name: 'clip.mp4', type: 'file' as const, identity: '9:1' },
        { name: 'voice.mp3', type: 'file' as const, identity: '8:1' },
        { name: 'photo.png', type: 'file' as const, identity: '7:1' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push(`${url.pathname}?${url.searchParams}`)
        if (url.pathname.endsWith('/files/pdf')) {
            if (url.searchParams.get('path')?.endsWith('.pdf')) return new Response(deck, { headers: { 'content-type': 'application/pdf' } })
            return Response.json({ error: 'This PDF is damaged and can’t be previewed.' }, { status: 415 })
        }
        if (url.pathname.endsWith('/files/video')) return new Response(Uint8Array.from([0, 0, 0, 16]), { headers: { 'content-type': 'video/mp4' } })
        if (url.pathname.endsWith('/files/audio')) return new Response(Uint8Array.from([0xff, 0xfb, 0x90, 0xc0]), { headers: { 'content-type': 'audio/mpeg' } })
        if (url.pathname.endsWith('/files/image')) return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
        if (url.pathname.endsWith('/files/read')) return Response.json({ path: url.searchParams.get('path'), content: 'hello notes', size: 11, truncated: false, hash: 'abc' })
        if (url.searchParams.get('path') === 'docs') return Response.json({ path: 'docs', entries: docs.map(entry => ({ ...entry, size: 20, modifiedAt: '2026-11-04T00:00:00.000Z' })) })
        if (url.searchParams.get('path') === 'solo') return Response.json({ path: 'solo', entries: [{ name: 'only.pdf', type: 'file', size: 20, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '1:1' }] })
        return Response.json({ path: '', entries: [{ name: 'docs', type: 'dir', size: 0, modifiedAt: '2026-11-04T00:00:00.000Z' }, { name: 'solo', type: 'dir', size: 0, modifiedAt: '2026-11-04T00:00:00.000Z' }] })
    }))
    return calls
}

async function openFolder(name: string) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click(name)
    await flush()
    return root
}

test('an existing PDF opens the original iframe from the desktop PDF route', async () => {
    const calls = installFetch()
    const root = await openFolder('docs')
    await click('alpha.pdf')
    await flush()

    const pdfCall = calls.find(call => call.includes('/files/pdf'))
    expect(pdfCall).toBeDefined()
    const pdfUrl = new URL(pdfCall!, 'http://127.0.0.1')
    expect(pdfUrl.searchParams.get('path')).toBe('docs/alpha.pdf')
    expect(pdfUrl.searchParams.get('identity')).toBe('3:1')
    expect(calls.some(call => call.includes('/files/read') && call.includes('alpha.pdf'))).toBe(false)
    expect(calls.some(call => call.includes('/files/image') && call.includes('alpha.pdf'))).toBe(false)
    expect(calls.some(call => call.includes('/files/audio') && call.includes('alpha.pdf'))).toBe(false)
    expect(calls.some(call => call.includes('/files/video') && call.includes('alpha.pdf'))).toBe(false)
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="file-pdf-preview"]')
    expect(frame?.title).toBe('alpha.pdf')
    expect(frame?.className).toContain('h-full')
    expect(frame?.className).toContain('w-full')
    expect(frame?.className).toContain('bg-white')
    expect(frame?.getAttribute('src')?.startsWith('blob:')).toBe(true)
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(frame?.getAttribute('csp')).toBe(DESKTOP_PDF_FRAME_CSP)
    expect(frame?.hasAttribute('allow')).toBe(false)
    await act(async () => { frame!.dispatchEvent(new Event('load')) })
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(button('Previous file')).toBeDefined()
    expect(button('Next file')).toBeDefined()
    expect(document.body.textContent).toContain('1 / 5')
    expect(button('Edit')).toBeUndefined()
    expect(button('Download')).toBeUndefined()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-video-preview"]')).toBeNull()

    await click('Next file')
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-video-preview"]')).not.toBeNull()
    expect(calls.some(call => call.includes('/files/video') && call.includes('docs%2Fclip.mp4'))).toBe(true)
    await click('Back')
    await flush()
    expect(button('Workspace home')).toBeDefined()
    expect(button('alpha.pdf')).toBeDefined()
    expect(button('notes.md')).toBeDefined()
    await click('notes.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('hello notes')
    await click('Back to folder')
    await flush()

    await click('photo.png')
    await flush()
    expect(calls.some(call => call.includes('/files/image') && call.includes('photo.png'))).toBe(true)
    expect(calls.some(call => call.includes('/files/pdf') && call.includes('photo.png'))).toBe(false)
    await click('Back')
    await flush()
    await click('voice.mp3')
    await flush()
    expect(calls.some(call => call.includes('/files/audio') && call.includes('voice.mp3'))).toBe(true)
    expect(calls.some(call => call.includes('/files/pdf') && call.includes('voice.mp3'))).toBe(false)
    await click('Back')
    await flush()
    await click('clip.mp4')
    await flush()
    expect(calls.some(call => call.includes('/files/video') && call.includes('clip.mp4'))).toBe(true)
    expect(calls.some(call => call.includes('/files/pdf') && call.includes('clip.mp4'))).toBe(false)
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('one PDF in a folder has no previous or next arrow', async () => {
    installFetch()
    const root = await openFolder('solo')
    await click('only.pdf')
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).not.toBeNull()
    expect(button('Previous file')).toBeUndefined()
    expect(button('Next file')).toBeUndefined()
    await click('Back')
    await flush()
    expect(button('only.pdf')).toBeDefined()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('a display error shows its own sentence and removes the iframe', async () => {
    installFetch()
    const root = await openFolder('docs')
    await click('alpha.pdf')
    await flush()
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="file-pdf-preview"]')
    expect(frame).not.toBeNull()
    await act(async () => { frame!.dispatchEvent(new Event('error')) })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This PDF can’t be displayed.')
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('Back cancels an in-flight read and releases the preview', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/files/pdf')) {
            await gate
            if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
            return new Response(deck, { headers: { 'content-type': 'application/pdf' } })
        }
        return Response.json({ path: '', entries: [{ name: 'deck.pdf', type: 'file', size: deck.byteLength, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '1:1' }] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('deck.pdf')
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-loading"]')).not.toBeNull()
    await click('Back')
    release!()
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(button('deck.pdf')).toBeDefined()
    expect(revoke).not.toHaveBeenCalled()
    act(() => root.unmount())
})

test('Back releases the iframe before folder navigation, and switching coworker drops it', async () => {
    installFetch()
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('docs')
    await flush()
    await click('alpha.pdf')
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).not.toBeNull()
    await click('Back')
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    await click('Workspace home')
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    expect(revoke).toHaveBeenCalled()
    await click('docs')
    await flush()
    await click('alpha.pdf')
    await flush()
    await act(async () => { root.render(<DesktopCoworkerFiles agent={{ ...coworker, id: 'bob', name: 'Bob' }} />) })
    await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('a read failure shows the server sentence and no iframe', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/files/pdf')) return Response.json({ error: 'This PDF is damaged and can’t be previewed.' }, { status: 415 })
        return Response.json({ path: '', entries: [{ name: 'deck.pdf', type: 'file', size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '1:1' }] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('deck.pdf')
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This PDF is damaged and can’t be previewed.')
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    act(() => root.unmount())
})
