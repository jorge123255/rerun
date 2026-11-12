// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { onePixelPng } from '@/lib/desktop/server/shared-file-previews/test-helpers'
import { DesktopSharedFiles } from '../DesktopSharedFiles'

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), upload: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: api.list, readDesktopSharedPreview: api.read, importDesktopSharedFile: api.upload }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
async function click(name: string) { await act(async () => { button(name)!.click() }); await flush() }
const version = 'd'.repeat(64)
async function arrow(key: string, target: EventTarget = window, modifiers?: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...modifiers })
    await act(async () => { target.dispatchEvent(event) })
    await flush()
    return event.defaultPrevented
}
async function openFile(name: string) {
    const row = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.querySelector('.truncate')?.textContent === name)
    expect(row, name).toBeDefined()
    await act(async () => { row!.click() })
    await flush()
}
async function mount() {
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root.render(<DesktopSharedFiles workspaceId={2} />)
    })
    await click('Shared files')
}

beforeEach(() => {
    api.list.mockReset().mockImplementation(async (path: string) => ({ path, entries: path ? [] : [
        { name: 'pixel.png', type: 'file', size: 4, modified: '', deleteRevision: version },
        { name: 'note.txt', type: 'file', size: 4, modified: '', deleteRevision: version },
    ], truncated: false }))
    api.read.mockReset().mockResolvedValue({ path: 'note.txt', content: 'shared body', truncated: false, offset: 0, nextOffset: null, deleteRevision: version })
    api.upload.mockReset()
    api.save.mockReset().mockResolvedValue(true)
    vi.unstubAllGlobals()
    vi.stubGlobal('desktopApp', { saveSharedFile: api.save })
})
afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

test('previews supported shared media and saves exact reviewed bytes with sibling navigation intact', async () => {
    const png = onePixelPng()
    const hash = 'a'.repeat(64)
    const fetchMedia = vi.fn(async (_url: string) => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'x-rerun-shared-sha256': hash } }))
    vi.stubGlobal('fetch', fetchMedia)
    await mount()
    await openFile('pixel.png')
    expect(document.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
    expect(document.querySelectorAll('[aria-label="Next file"]')).toHaveLength(1)
    expect(document.querySelectorAll('[aria-label="Previous file"]')).toHaveLength(1)
    expect(document.querySelectorAll('[aria-label="Back to folder"]')).toHaveLength(1)
    expect(await arrow('ArrowRight')).toBe(true)
    expect(document.querySelector('pre')?.textContent).toBe('shared body')
    expect(await arrow('ArrowLeft', window, { metaKey: true })).toBe(false)
    expect(document.querySelector('pre')?.textContent).toBe('shared body')
    await click('Previous file')
    await click('Save As')
    expect(api.save).toHaveBeenCalledWith({ workspaceId: 2, path: 'pixel.png', version, identity: hash })
    expect(document.body.textContent).toContain('Saved pixel.png')
    expect(fetchMedia.mock.calls.every(([url]) => !String(url).includes('download'))).toBe(true)
    api.save.mockRejectedValueOnce(new Error('This shared file changed.'))
    await click('Save As')
    expect(document.body.textContent).not.toContain('Saved pixel.png')

    const picker = Promise.withResolvers<boolean>()
    api.save.mockReturnValueOnce(picker.promise)
    await click('Save As')
    expect(await arrow('ArrowRight')).toBe(false)
    expect(document.querySelector('img')?.getAttribute('alt')).toBe('pixel.png')
    await act(async () => picker.resolve(false))
    expect(await arrow('ArrowRight')).toBe(true)
    expect(document.querySelector('pre')?.textContent).toBe('shared body')
})

test('lets the editor and media controls keep their arrow keys and returns to the exact folder', async () => {
    const hash = 'b'.repeat(64)
    const files = [{ name: 'note.txt', type: 'file', size: 11, modified: '', deleteRevision: version },
        { name: 'voice.mp3', type: 'file', size: 8, modified: '', deleteRevision: version }]
    api.list.mockImplementation(async (path: string) => ({
        path, entries: path === 'docs' ? files : [{ name: 'docs', type: 'dir', size: 0, modified: '' }], truncated: false,
    }))
    api.read.mockResolvedValue({ path: 'docs/note.txt', content: 'shared body', truncated: false, deleteRevision: version,
        editIdentity: { expectedBytes: 11, expectedSha256: hash } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([255, 251, 144, 192, 0, 0, 0, 0]), {
        headers: { 'content-type': 'audio/mpeg', 'x-rerun-shared-sha256': hash },
    })))
    await mount()
    await openFile('docs')
    await openFile('note.txt')
    await click('Edit')
    expect(await arrow('ArrowRight')).toBe(false)
    expect(button('Close editor')).toBeDefined()
    expect(button('Next file')).toBeUndefined()
    await click('Close editor')
    expect(await arrow('ArrowRight')).toBe(true)
    const player = document.querySelector('audio')
    expect(player).not.toBeNull()
    expect(await arrow('ArrowLeft', player!)).toBe(false)
    expect(document.querySelector('audio')).toBe(player)
    await click('Back to folder')
    expect(document.querySelector('audio')).toBeNull()
    expect(api.list.mock.calls.at(-1)?.[0]).toBe('docs')
    await openFile('note.txt')
    expect(api.read.mock.calls.at(-1)?.[0]).toBe('docs/note.txt')
})

test('opens a shared CSV and saves the exact version from its text preview', async () => {
    const path = 'report.csv', content = 'city,count\r\nQuébec,1\r\n', hash = 'b'.repeat(64)
    const bytes = new TextEncoder().encode(content)
    api.list.mockResolvedValue({ path: '', entries: [{ name: path, type: 'file', size: bytes.length, modified: '', deleteRevision: version }], truncated: false })
    api.read.mockResolvedValue({ path, content, truncated: false, deleteRevision: version, editIdentity: { expectedBytes: bytes.length, expectedSha256: hash } })
    const download = vi.fn()
    vi.stubGlobal('fetch', download)
    await mount()
    await openFile(path)
    expect(document.querySelector('pre')?.textContent).toBe(content)
    expect(button('Edit')).toBeDefined()
    expect(button('Save As')?.disabled).toBe(false)
    await click('Save As')
    expect(download).not.toHaveBeenCalled()
    expect(api.save).toHaveBeenCalledWith({ workspaceId: 2, path, version, identity: hash })
})

test('saves a listed file directly and leaves the folder unchanged if the native picker is canceled', async () => {
    await mount()
    const chooseSave = async () => {
        const trigger = button('Actions for note.txt')!
        await act(async () => {
            trigger.focus()
            trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        })
        await flush()
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Save As')
        expect(item).toBeDefined()
        await act(async () => { item!.click() })
        await flush()
    }
    api.save.mockResolvedValueOnce(false)
    await chooseSave()
    expect(api.save).toHaveBeenCalledWith({ workspaceId: 2, path: 'note.txt', version })
    expect(api.read).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Saved note.txt')
    await chooseSave()
    expect(document.body.textContent).toContain('Saved note.txt')
})

test('uses the versioned Save As for a binary with no preview', async () => {
    api.list.mockResolvedValue({ path: '', entries: [{ name: 'archive.zip', type: 'file', size: 10, modified: '', deleteRevision: version }], truncated: false })
    await mount()
    await openFile('archive.zip')
    expect(document.querySelector('a[download]')).toBeNull()
    await click('Save As')
    expect(api.save).toHaveBeenCalledWith({ workspaceId: 2, path: 'archive.zip', version })
})
