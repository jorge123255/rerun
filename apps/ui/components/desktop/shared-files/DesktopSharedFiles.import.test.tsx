// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopSharedFiles } from '../DesktopSharedFiles'

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), upload: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: api.list, readDesktopSharedPreview: api.read, importDesktopSharedFiles: api.upload }))
vi.mock('sonner', () => ({ toast: { error: api.error } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
async function click(name: string) { await act(async () => { button(name)!.click() }); await flush() }

beforeEach(() => {
    api.list.mockReset().mockImplementation(async (path: string) => ({ path, entries: [], truncated: false }))
    api.read.mockReset()
    api.upload.mockReset()
    api.error.mockReset()
})
afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
})

test('groups nested files and retries only a refusal with the original bytes', async () => {
    api.upload.mockImplementation(async (folder: string, files: File[]) => files.map(file => file.name === 'existing.txt'
        ? { name: file.name, folder, status: 'refused', message: 'This folder already has a file with that name.' }
        : { name: file.name, folder, status: 'created', path: [folder, file.name].filter(Boolean).join('/') }))
    const nested = new File([Uint8Array.from([0, 255, 1])], 'existing.txt')
    Object.defineProperty(nested, 'webkitRelativePath', { configurable: true, value: 'nested/existing.txt' })
    const ordinary = new File(['# shared'], 'note.md')
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root!.render(<DesktopSharedFiles />)
    })
    await click('Shared files')
    const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])')!
    Object.defineProperty(input, 'files', { configurable: true, value: [nested, ordinary] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect(document.body.textContent).toContain('nested/existing.txt')
    expect(document.body.textContent).toContain('refused')
    expect(api.upload).toHaveBeenCalledTimes(2)
    expect(api.upload).toHaveBeenNthCalledWith(1, 'nested', [nested], expect.any(AbortSignal))
    expect(api.upload).toHaveBeenNthCalledWith(2, '', [ordinary], expect.any(AbortSignal))
    await click('Retry import nested/existing.txt')
    expect(api.upload).toHaveBeenCalledTimes(3)
    expect(api.upload).toHaveBeenNthCalledWith(3, 'nested', [nested], expect.any(AbortSignal))
    expect(document.body.textContent).toContain('refused')
})
