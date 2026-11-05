// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
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
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

test('an existing raster opens the original image frame from the desktop image route', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push(`${url.pathname}?${url.searchParams}`)
        if (url.pathname.endsWith('/files/image')) {
            if (url.searchParams.get('path') === 'docs/photo.png') return new Response(png, { headers: { 'content-type': 'image/png' } })
            return Response.json({ error: 'Only PNG, JPEG, WebP, and GIF files can be previewed.' }, { status: 415 })
        }
        if (url.pathname.endsWith('/files/read')) return Response.json({ path: url.searchParams.get('path'), content: 'hello notes', size: 11, truncated: false, hash: 'abc' })
        if (url.searchParams.get('path') === 'docs') return Response.json({ path: 'docs', entries: [
            { name: 'notes.md', type: 'file', size: 11, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '4:8' },
            { name: 'photo.png', type: 'file', size: png.byteLength, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '7:1' },
            { name: 'draw.svg', type: 'file', size: 12, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '7:2' },
        ] })
        return Response.json({ path: '', entries: [{ name: 'docs', type: 'dir', size: 0, modifiedAt: '2026-11-04T00:00:00.000Z' }] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('docs')
    await flush()
    await click('photo.png')
    await flush()

    const imageCall = calls.find(call => call.includes('/files/image'))
    expect(imageCall).toBeDefined()
    const imageUrl = new URL(imageCall!, 'http://127.0.0.1')
    expect(imageUrl.searchParams.get('path')).toBe('docs/photo.png')
    expect(imageUrl.searchParams.get('identity')).toBe('7:1')
    expect(calls.some(call => call.includes('/files/read') && call.includes('photo.png'))).toBe(false)
    const img = document.querySelector<HTMLImageElement>('[data-testid="file-image-preview"]')
    expect(img?.getAttribute('alt')).toBe('photo.png')
    expect(img?.className).toContain('max-h-full')
    expect(img?.className).toContain('max-w-full')
    expect(img?.className).toContain('object-contain')
    expect(img?.getAttribute('src')?.startsWith('blob:')).toBe(true)
    expect(button('Edit')).toBeUndefined()
    expect(button('Download')).toBeUndefined()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()

    await click('Back')
    await flush()
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    await click('notes.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('hello notes')
    expect(calls.some(call => call.includes('/files/read') && call.includes('notes.md'))).toBe(true)

    await click('Back to folder')
    await flush()
    await click('draw.svg')
    await flush()
    expect(calls.some(call => call.includes('/files/image') && call.includes('draw.svg'))).toBe(true)
    expect(calls.some(call => call.includes('/files/read') && call.includes('draw.svg'))).toBe(false)
    act(() => root.unmount())
})

test('a refused image shows the server message and no image element', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/files/image')) return Response.json({ error: 'This image is damaged and can’t be previewed.' }, { status: 415 })
        return Response.json({ path: '', entries: [{ name: 'photo.png', type: 'file', size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '1:1' }] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files')
    await flush()
    await click('photo.png')
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This image is damaged and can’t be previewed.')
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    act(() => root.unmount())
})
