// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { onePixelPng } from '@/lib/desktop/server/shared-file-previews/test-helpers'
import { DesktopSharedFiles } from '../DesktopSharedFiles'

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), upload: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: api.list, readDesktopSharedPreview: api.read, importDesktopSharedFile: api.upload }))
vi.mock('@/lib/desktop/result-file-save', () => ({ saveDesktopResultFile: api.save }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
async function click(name: string) { await act(async () => { button(name)!.click() }); await flush() }

beforeEach(() => {
    api.list.mockReset().mockImplementation(async (path: string) => ({ path, entries: path ? [] : [{ name: 'pixel.png', type: 'file', size: 4, modified: '2026-11-05T00:00:00Z' }, { name: 'note.txt', type: 'file', size: 4, modified: '2026-11-05T00:00:00Z' }], truncated: false }))
    api.read.mockReset().mockResolvedValue({ path: 'note.txt', content: 'shared body', truncated: false, offset: 0, nextOffset: null })
    api.upload.mockReset()
    api.save.mockReset().mockResolvedValue(true)
    vi.unstubAllGlobals()
})
afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

test('previews supported shared media and saves exact reviewed bytes with sibling navigation intact', async () => {
    const png = onePixelPng()
    let changed = false
    const hash = 'a'.repeat(64)
    const fetchMedia = vi.fn(async (url: string) => {
        const query = new URL(url, 'http://localhost').searchParams
        if (query.has('download') && changed) return Response.json({ error: 'This shared file changed.' }, { status: 409 })
        return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'x-rerun-shared-sha256': hash } })
    })
    vi.stubGlobal('fetch', fetchMedia)
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root!.render(<DesktopSharedFiles />)
    })
    await click('Shared files')
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.querySelector('.truncate')?.textContent === 'pixel.png')!.click() })
    await flush()
    expect(document.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
    await click('Next file')
    expect(document.querySelector('pre')?.textContent).toBe('shared body')
    await click('Previous file')
    await click('Save As')
    expect(api.save).toHaveBeenCalledWith('pixel.png', expect.any(Uint8Array))
    const bytes = api.save.mock.calls[0][1] as Uint8Array
    expect(Buffer.from(bytes).equals(png)).toBe(true)
    expect(document.body.textContent).toContain('Saved pixel.png')
    expect(fetchMedia).toHaveBeenLastCalledWith(expect.stringContaining(`identity=${hash}`), expect.any(Object))
    changed = true
    await click('Save As')
    expect(api.save).toHaveBeenCalledTimes(1)
})
