// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FileList } from '@/components/files/FileList'
import { DesktopSharedFiles } from '../DesktopSharedFiles'

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), upload: vi.fn(), rename: vi.fn(), remove: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: api.list, readDesktopSharedPreview: api.read, importDesktopSharedFiles: api.upload, renameDesktopSharedEntry: api.rename, deleteDesktopSharedEntry: api.remove }))
vi.mock('sonner', () => ({ toast: { error: api.error } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const revision = 'a'.repeat(64)
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const button = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="button"] span.truncate,button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
async function click(name: string) { await act(async () => { button(name)!.click() }); await flush() }
async function change(field: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
        field.dispatchEvent(new Event('change', { bubbles: true }))
    })
}

beforeEach(() => {
    api.list.mockReset().mockImplementation(async (path: string) => ({
        path,
        entries: path === '' ? [{ name: 'docs', type: 'dir', size: 0, modified: '' }] : [],
        truncated: false,
    }))
    api.read.mockReset()
    api.upload.mockReset()
    api.rename.mockReset()
    api.remove.mockReset()
    api.error.mockReset()
})
afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
})

async function mount(names = ['brief.md', 'taken.md']) {
    api.list.mockImplementation(async (path: string) => ({
        path,
        entries: path === ''
            ? [{ name: 'docs', type: 'dir', size: 0, modified: '' }]
            : names.map(name => ({ name, type: 'file', size: 8, modified: '', deleteRevision: revision })),
        truncated: false,
    }))
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root!.render(<DesktopSharedFiles workspaceId={7} />)
    })
    await click('Shared files')
    expect(button('Actions for docs')).toBeUndefined()
    await click('docs')
}

async function startRename(name: string) {
    await act(async () => {
        const trigger = button(`Actions for ${name}`)!
        trigger.focus()
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await flush()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Rename')
    expect(item).toBeDefined()
    await act(async () => { item!.click() })
    await flush()
    const field = document.querySelector<HTMLInputElement>('input[aria-label="New name"]')!
    expect(document.activeElement).toBe(field)
    return field
}

async function submitRename(field: HTMLInputElement, next: string) {
    await change(field, next)
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await flush()
}

async function rename(name: string, next: string, end = name.lastIndexOf('.')) {
    const field = await startRename(name)
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, end])
    await submitRename(field, next)
}

test('submits the entry chosen in the menu even if a refreshed listing replaces it while editing', async () => {
    const selected = { name: 'Release', type: 'dir' as const, size: 0, modified: '', deleteRevision: revision }
    const onRename = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (entry: typeof selected) => act(async () => {
        root!.render(<FileList title="Files" entries={[entry]} onOpen={() => {}} onUpload={() => {}} onRename={onRename} />)
    })
    await render(selected)
    const field = await startRename(selected.name)
    await render({ ...selected, deleteRevision: 'b'.repeat(64) })
    await submitRename(field, 'Archive')
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Release', 'Archive', selected)
})

test('renames a file inline and refreshes its exact folder', async () => {
    const names = ['brief.md', 'taken.md']
    api.rename.mockImplementation(async (_workspace: number, _path: string, name: string) => {
        names[0] = name
        return { path: `docs/${name}`, name }
    })
    await mount(names)
    await rename('brief.md', '  plan.md  ')
    expect(api.rename).toHaveBeenCalledWith(7, 'docs/brief.md', 'plan.md', revision, expect.any(AbortSignal))
    expect(api.list.mock.calls.filter(([path]) => path === 'docs').length).toBeGreaterThanOrEqual(2)
    expect(button('plan.md')).toBeDefined()
    expect(button('brief.md')).toBeUndefined()
})

test('renames a folder inline and selects its whole name even when it contains a dot', async () => {
    let name = 'release.v1'
    api.list.mockImplementation(async (path: string) => ({
        path, entries: path === '' ? [{ name, type: 'dir', size: 0, modified: '', deleteRevision: revision }] : [], truncated: false,
    }))
    api.rename.mockImplementation(async (_workspace: number, _path: string, next: string) => {
        name = next
        return { path: next, name: next }
    })
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root.render(<DesktopSharedFiles workspaceId={7} />)
    })
    await click('Shared files')
    await rename('release.v1', 'Archive', 'release.v1'.length)
    expect(api.rename).toHaveBeenCalledExactlyOnceWith(7, 'release.v1', 'Archive', revision, expect.any(AbortSignal))
    expect(button('Archive')).toBeDefined()
    expect(button('release.v1')).toBeUndefined()
})

test('keeps both names and reports a collision without refreshing away the source', async () => {
    api.rename.mockRejectedValue(new Error('The existing file was kept.'))
    await mount()
    await rename('brief.md', 'taken.md')
    expect(api.error).toHaveBeenCalledWith('The existing file was kept.')
    expect(button('brief.md')).toBeDefined()
    expect(button('taken.md')).toBeDefined()
})

test('preview Delete cancels without changing the file, then deletes the exact revision and returns to the folder', async () => {
    const revision = 'c'.repeat(64)
    let present = true
    const keep = { name: 'keep.txt', type: 'file', size: 4, modified: '', deleteRevision: 'a'.repeat(64) }
    const note = { name: 'note.txt', type: 'file', size: 5, modified: '', deleteRevision: revision }
    api.list.mockImplementation(async (path: string) => ({ path, entries: present ? [note, keep] : [keep], truncated: false }))
    api.read.mockResolvedValue({ path: 'note.txt', content: 'hello', size: 5, truncated: false, deleteRevision: revision })
    api.remove.mockImplementation(async () => { present = false })
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root.render(<DesktopSharedFiles workspaceId={7} />)
    })
    await click('Shared files')
    await click('note.txt')
    await click('Delete file')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('deleted from the workspace')
    await click('Cancel')
    expect(api.remove).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('hello')
    await click('Delete file')
    await click('Delete')
    expect(api.remove).toHaveBeenCalledOnce()
    expect(api.remove).toHaveBeenCalledWith(7, 'note.txt', revision, expect.any(AbortSignal))
    expect(button('note.txt')).toBeUndefined()
    expect(button('keep.txt')).toBeDefined()
})

test('folder Delete uses the revision shown before confirmation', async () => {
    const original = '1'.repeat(64)
    const revised = '2'.repeat(64)
    let version = original
    api.list.mockImplementation(async (path: string) => ({
        path, entries: [{ name: 'docs', type: 'dir', size: 0, modified: '', deleteRevision: version }], truncated: false,
    }))
    api.remove.mockRejectedValue(new Error('“docs” changed since it was selected. It was left unchanged.'))
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root.render(<DesktopSharedFiles workspaceId={7} />)
    })
    await click('Shared files')
    await act(async () => {
        const trigger = button('Actions for docs')!
        trigger.focus()
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await flush()
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Delete')
    expect(action).toBeDefined()
    await act(async () => { action!.click() })
    await flush()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('folder and everything inside it')
    version = revised
    await click('Delete')
    expect(api.remove).toHaveBeenCalledWith(7, 'docs', original, expect.any(AbortSignal))
    expect(button('docs')).toBeDefined()
    expect(api.error).toHaveBeenCalledWith(expect.stringContaining('left unchanged'))
})
