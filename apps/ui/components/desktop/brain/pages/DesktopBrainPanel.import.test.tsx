// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { DesktopBrainPanel } from './DesktopBrainPanel'
import type { DesktopBrainActions } from './types'

const shared = vi.hoisted(() => ({ list: vi.fn(), upload: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: shared.list, importDesktopSharedFiles: shared.upload }))
vi.mock('@/lib/desktop/use-brain-page-draft', () => ({ flushDesktopBrainDrafts: vi.fn(async () => true), forgetBrainDraft: vi.fn(), brainDraftHash: vi.fn(() => null) }))
vi.mock('@/lib/desktop/data-source', () => ({ desktopDataSource: () => ({ listTables: vi.fn(async () => []) }) }))
vi.mock('@/lib/desktop/draft-writes', () => ({ holdDraftAdmission: () => () => {}, isDesktopQuitting: () => false, subscribeDraftShutdown: () => () => {} }))
vi.mock('@/components/brain/editor/file-link', () => ({ SHARED_FILE_DRAG_TYPE: 'application/x-rerun-shared-file' }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/data/DataBrowser', () => ({ DataBrowser: () => null }))
vi.mock('@/components/desktop/shared-files/DesktopSharedFilePreview', () => ({ DesktopSharedFilePreview: () => null }))
vi.mock('./DesktopBrainPage', () => ({ DesktopBrainPage: () => null }))
vi.mock('./DesktopBrainHistory', () => ({ DesktopBrainHistory: () => null }))
vi.mock('./DesktopBrainNewPage', () => ({ DesktopBrainNewPage: () => null }))
vi.mock('sonner', () => ({ toast: { error: shared.error } }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }) })
}

const actions = { load: vi.fn(async () => ({ pages: [], openProposals: 0 })), readPage: vi.fn(), savePage: vi.fn(), deletePage: vi.fn(), readRevision: vi.fn(), revertPage: vi.fn(), confirmSections: vi.fn() } as unknown as DesktopBrainActions
const files: SharedFilesTree = { entriesOf: vi.fn(() => []), expanded: new Set<string>(), toggle: vi.fn(), expand: vi.fn(), refresh: vi.fn(async () => {}), knownFiles: [] }
let root: Root | undefined

beforeEach(() => {
    shared.list.mockReset().mockImplementation(async (path: string) => ({ path, entries: [], truncated: false }))
    shared.upload.mockReset()
    shared.error.mockReset()
    vi.mocked(files.refresh).mockClear()
})

afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
})

async function settle() {
    for (let index = 0; index < 6; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function mount() {
    await act(async () => {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        root!.render(<DesktopBrainPanel actions={actions} onClose={() => {}} files={files} route={{ selection: { kind: 'folder', path: '' } }} />)
    })
    await settle()
}

async function pick(entries: File[]) {
    const input = document.querySelector<HTMLInputElement>('main input[type="file"]:not([webkitdirectory])')!
    Object.defineProperty(input, 'files', { configurable: true, value: entries })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
}

async function click(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('main button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)
    expect(button).toBeDefined()
    await act(async () => { button!.click() })
    await settle()
}

it('keeps mixed nested outcomes and retries only the refused result in its destination', async () => {
    shared.upload.mockImplementation(async (folder: string, batch: File[]) => batch.map(file => {
        if (file.name === 'existing.txt') return { name: file.name, folder, status: 'refused', message: 'The existing file was kept.' }
        if (file.name === 'uncertain.pdf') return { name: file.name, folder, status: 'uncertain', message: 'Inspect before retrying.' }
        return { name: file.name, folder, status: 'created', path: [folder, file.name].filter(Boolean).join('/') }
    }))
    const nested = new File([Uint8Array.from([0, 255, 1])], 'existing.txt')
    Object.defineProperty(nested, 'webkitRelativePath', { configurable: true, value: 'nested/existing.txt' })
    const ordinary = new File(['# shared'], 'note.md')
    const uncertain = new File(['pdf'], 'uncertain.pdf')
    await mount()
    await pick([nested, ordinary, uncertain])
    expect(shared.upload).toHaveBeenCalledTimes(2)
    expect(shared.upload).toHaveBeenNthCalledWith(1, 'nested', [nested], expect.any(AbortSignal))
    expect(shared.upload).toHaveBeenNthCalledWith(2, '', [ordinary, uncertain], expect.any(AbortSignal))
    expect(document.querySelector('main')?.textContent).toContain('nested/existing.txt')
    expect(document.querySelector('main')?.textContent).toContain('refused')
    expect(document.querySelector('main')?.textContent).toContain('uncertain.pdf')
    expect(document.querySelector('button[aria-label="Retry import uncertain.pdf"]')).toBeNull()
    expect(files.refresh).toHaveBeenCalledWith('')
    await click('Retry import nested/existing.txt')
    expect(shared.upload).toHaveBeenCalledTimes(3)
    expect(shared.upload).toHaveBeenNthCalledWith(3, 'nested', [nested], expect.any(AbortSignal))
    expect(shared.upload).not.toHaveBeenCalledWith('', [uncertain], expect.any(AbortSignal))
})

it('presents a failed request as uncertain without an automatic or manual effect retry', async () => {
    shared.upload.mockRejectedValue(new Error('Connection lost after upload.'))
    await mount()
    await pick([new File(['image'], 'image.png')])
    expect(document.querySelector('main')?.textContent).toContain('uncertain')
    expect(document.querySelector('main')?.textContent).toContain('Connection lost after upload.')
    expect(document.querySelector('button[aria-label="Retry import image.png"]')).toBeNull()
    await settle()
    expect(shared.upload).toHaveBeenCalledTimes(1)
})
