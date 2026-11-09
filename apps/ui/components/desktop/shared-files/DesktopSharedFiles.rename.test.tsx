// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopSharedFiles } from '../DesktopSharedFiles'

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), upload: vi.fn(), rename: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: api.list, readDesktopSharedPreview: api.read, importDesktopSharedFiles: api.upload, renameDesktopSharedFile: api.rename }))
vi.mock('sonner', () => ({ toast: { error: api.error } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
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
            : names.map(name => ({ name, type: 'file', size: 8, modified: '' })),
        truncated: false,
    }))
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root!.render(<DesktopSharedFiles />)
    })
    await click('Shared files')
    expect(button('Actions for docs')).toBeUndefined()
    await click('docs')
}

async function rename(name: string, next: string) {
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
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, name.lastIndexOf('.')])
    await change(field, next)
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await flush()
}

test('renames a file inline and refreshes its exact folder', async () => {
    const names = ['brief.md', 'taken.md']
    api.rename.mockImplementation(async (path: string, name: string) => {
        names[0] = name
        return { path: `docs/${name}`, name }
    })
    await mount(names)
    await rename('brief.md', '  plan.md  ')
    expect(api.rename).toHaveBeenCalledWith('docs/brief.md', 'plan.md', expect.any(AbortSignal))
    expect(api.list.mock.calls.filter(([path]) => path === 'docs').length).toBeGreaterThanOrEqual(2)
    expect(button('plan.md')).toBeDefined()
    expect(button('brief.md')).toBeUndefined()
})

test('keeps both names and reports a collision without refreshing away the source', async () => {
    api.rename.mockRejectedValue(new Error('The existing file was kept.'))
    await mount()
    await rename('brief.md', 'taken.md')
    expect(api.error).toHaveBeenCalledWith('The existing file was kept.')
    expect(button('brief.md')).toBeDefined()
    expect(button('taken.md')).toBeDefined()
})
