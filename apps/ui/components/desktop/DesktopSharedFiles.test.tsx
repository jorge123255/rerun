// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopSharedFiles } from './DesktopSharedFiles'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), upload: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: api.list, readDesktopSharedPreview: api.read, importDesktopSharedFile: api.upload }))
vi.mock('sonner', () => ({ toast: { error: api.error } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const entry = (name: string, type: 'file' | 'dir' = 'file') => ({ name, type, size: 4, modified: '2026-11-05T00:00:00Z' })
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
async function click(name: string) {
    const target = button(name)
    expect(target, name).toBeDefined()
    await act(async () => { target!.click() })
    await flush()
}
async function row(name: string) {
    const target = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.querySelector('.truncate')?.textContent === name)
    expect(target, name).toBeDefined()
    await act(async () => { target!.click() })
    await flush()
}
async function open() {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root!.render(<DesktopSharedFiles />) })
    await click('Shared files')
}
async function pick(names: string[]) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])')!
    expect(input).not.toBeNull()
    Object.defineProperty(input, 'files', { configurable: true, value: names.map(name => new File(['body'], name)) })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
}

beforeEach(() => {
    cancelDraftShutdown()
    api.list.mockReset().mockImplementation(async (path: string) => ({ path, entries: path ? [entry('nested.txt')] : [entry('docs', 'dir'), entry('note.txt')], truncated: false }))
    api.read.mockReset().mockResolvedValue({ path: 'note.txt', content: 'shared body', truncated: false, offset: 0, nextOffset: null })
    api.upload.mockReset().mockResolvedValue({ path: 'imported.txt', name: 'imported.txt' })
    api.error.mockReset()
})
afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = undefined
    cancelDraftShutdown()
    document.body.innerHTML = ''
})

test('uses the shared folder layout and read preview without inactive mutation menus', async () => {
    await open()
    expect(document.querySelector('[aria-label="Actions for note.txt"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Rename')
    expect(document.body.textContent).not.toContain('Delete')
    await row('note.txt')
    expect(document.querySelector('pre')?.textContent).toBe('shared body')
    expect(api.read).toHaveBeenCalledWith('note.txt', expect.any(AbortSignal))
    await click('Files')
    await row('docs')
    await pick(['nested-new.md'])
    expect(api.upload).toHaveBeenCalledWith('docs', expect.objectContaining({ name: 'nested-new.md' }), expect.any(AbortSignal))
})

test.each(['close', 'navigate', 'quit'] as const)('%s stops a queued import after the in-flight file and releases Quit admission', async change => {
    let signal: AbortSignal | undefined
    api.upload.mockImplementationOnce((_folder: string, _file: File, current: AbortSignal) => new Promise((_resolve, reject) => {
        signal = current
        current.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
    }))
    await open()
    await pick(['one.txt', 'two.txt'])
    expect(api.upload).toHaveBeenCalledTimes(1)
    expect(document.querySelector('button[title="Upload"]')?.hasAttribute('disabled')).toBe(true)
    if (change === 'close') await click('Close')
    if (change === 'navigate') await row('docs')
    if (change === 'quit') await act(async () => { expect(await flushDesktopDrafts()).toBe(true) })
    await flush()
    expect(signal?.aborted).toBe(true)
    expect(api.upload).toHaveBeenCalledTimes(1)
    expect(api.error).not.toHaveBeenCalled()
    await act(async () => { expect(await flushDesktopDrafts()).toBe(true) })
})

test('failed listing and preview stay visible and can retry without claiming an empty folder', async () => {
    api.list.mockRejectedValueOnce(new Error('Cannot list this folder.'))
    await open()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Cannot list this folder.')
    expect(document.body.textContent).not.toContain('Nothing here yet')
    await click('Retry')
    api.read.mockRejectedValueOnce(new Error('File changed while reading.'))
    await row('note.txt')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('File changed while reading.')
    await click('Retry')
    expect(document.querySelector('pre')?.textContent).toBe('shared body')
})

test('empty shared files describes only supported import and reading', async () => {
    api.list.mockResolvedValue({ path: '', entries: [], truncated: false })
    await open()
    expect(document.body.textContent).toContain('Import a text or Markdown file')
    expect(document.body.textContent).not.toContain('Anything a coworker downloads')
})
