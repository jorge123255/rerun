// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { DesktopBrainPanel } from './DesktopBrainPanel'
import type { DesktopBrainActions } from './types'

const harness = vi.hoisted(() => {
    const { createElement } = require('react') as typeof import('react')
    const paths = ['readme.md', '../secret.md', '/data/agents/other/workspace/notes.md', 'missing.md', '', '%2e%2e/readme.md', 'shared:readme.md']
    const seen: {
        page: null | { files?: { path: string }[]; onOpenFile?: (path: string) => void }
        newer: null | { files?: { path: string }[]; onOpenFile?: (path: string) => void }
        history: null | { files?: { path: string }[]; onOpenFile?: (path: string) => void }
    } = { page: null, newer: null, history: null }
    const probe = (kind: 'page' | 'newer' | 'history', props: { files?: { path: string }[]; onOpenFile?: (path: string) => void; onHistory?: () => void }) => {
        seen[kind] = props
        return createElement('div', { 'data-testid': kind === 'newer' ? 'new-page' : kind, 'data-files': (props.files ?? []).map(file => file.path).join('|') },
            ...paths.map(path => createElement('button', { key: path || 'empty', type: 'button', 'aria-label': `${kind}:${path || 'empty'}`, onClick: () => props.onOpenFile?.(path) })),
            props.onHistory ? createElement('button', { type: 'button', onClick: props.onHistory }, 'Open history') : null,
        )
    }
    return { seen, probe }
})
const drafts = vi.hoisted(() => ({ flush: vi.fn(async () => true) }))
const shared = vi.hoisted(() => ({
    list: vi.fn(async (path: string) => ({ path, entries: [], truncated: false })),
    importFile: vi.fn(async () => ({ path: 'readme.md', name: 'readme.md' })),
}))

vi.mock('@/lib/desktop/use-brain-page-draft', () => ({ flushDesktopBrainDrafts: drafts.flush, forgetBrainDraft: vi.fn(), brainDraftHash: vi.fn(() => null) }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: shared.list, importDesktopSharedFile: shared.importFile }))
vi.mock('@/lib/desktop/data-source', () => ({ desktopDataSource: () => ({ listTables: vi.fn(async () => []) }) }))
vi.mock('@/components/brain/editor/file-link', () => ({ SHARED_FILE_DRAG_TYPE: 'application/x-rerun-shared-file' }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/data/DataBrowser', () => ({ DataBrowser: () => null }))
vi.mock('@/components/desktop/shared-files/DesktopSharedFilePreview', () => ({
    DesktopSharedFilePreview: ({ path }: { path: string }) => <div data-testid="file-preview">{path}</div>,
}))
vi.mock('./DesktopBrainPage', () => ({ DesktopBrainPage: (props: { files?: { path: string }[]; onOpenFile?: (path: string) => void; onHistory: () => void }) => harness.probe('page', props) }))
vi.mock('./DesktopBrainNewPage', () => ({ DesktopBrainNewPage: (props: { files?: { path: string }[]; onOpenFile?: (path: string) => void }) => harness.probe('newer', props) }))
vi.mock('./DesktopBrainHistory', () => ({ DesktopBrainHistory: (props: { files?: { path: string }[]; onOpenFile?: (path: string) => void }) => harness.probe('history', props) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }) })
}

const summary = { slug: 'pricing', title: 'Pricing', type: 'note' as const, hash: 'a'.repeat(32), updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'user:1' }
const detail = { page: { ...summary, content: 'Price', sources: [], unconfirmed: [], links: [], backlinks: [] }, revisions: [] }
const files: SharedFilesTree = {
    entriesOf: vi.fn(() => []),
    expanded: new Set<string>(),
    toggle: vi.fn(),
    expand: vi.fn(),
    refresh: vi.fn(async () => {}),
    knownFiles: [
        { path: 'readme.md', name: 'readme.md' },
        { path: '../secret.md', name: 'secret.md' },
        { path: '/data/agents/other/workspace/notes.md', name: 'notes.md' },
    ],
}

let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    harness.seen.page = null
    harness.seen.newer = null
    harness.seen.history = null
    drafts.flush.mockReset().mockResolvedValue(true)
    shared.importFile.mockClear()
    shared.list.mockClear()
})

function actionsFor(): DesktopBrainActions {
    return { load: vi.fn(async () => ({ pages: [summary], openProposals: 0 })), readPage: vi.fn(async () => detail), savePage: vi.fn(), deletePage: vi.fn(), readRevision: vi.fn(), revertPage: vi.fn(), confirmSections: vi.fn() } as unknown as DesktopBrainActions
}

async function settle() {
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function mount(extra: Partial<ComponentProps<typeof DesktopBrainPanel>> = {}) {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => { root!.render(<DesktopBrainPanel actions={actionsFor()} onClose={() => {}} files={files} {...extra} />) })
    await settle()
}

async function clickLabel(label: string) {
    const target = [...document.querySelectorAll<HTMLElement>('button')].find(node => (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim() === label)
    if (!target) throw new Error(`missing ${label}`)
    await act(async () => { target.click() })
    await settle()
}

it('passes only listed safe files into the page editor and opens that file through Brain navigation', async () => {
    await mount()
    expect(document.querySelector('[data-testid="page"]')?.getAttribute('data-files')).toBe('readme.md')
    expect(harness.seen.page?.onOpenFile).toBeTypeOf('function')
    await clickLabel('page:readme.md')
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('readme.md')
    expect(shared.importFile).not.toHaveBeenCalled()
    expect(shared.list.mock.calls.every(([path]) => path === '')).toBe(true)
    expect(document.querySelector('aside [draggable="true"]')).toBeNull()
})

it('keeps the page in place for a missing, unsafe, or other-workspace link', async () => {
    await mount()
    drafts.flush.mockClear()
    for (const label of ['page:../secret.md', 'page:/data/agents/other/workspace/notes.md', 'page:missing.md', 'page:empty', 'page:%2e%2e/readme.md', 'page:shared:readme.md']) {
        await clickLabel(label)
        expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
        expect(document.querySelector('[data-testid="page"]')).not.toBeNull()
    }
    expect(shared.importFile).not.toHaveBeenCalled()
    expect(drafts.flush).not.toHaveBeenCalled()
})

it('does not leave the page when its draft fails to flush', async () => {
    await mount()
    drafts.flush.mockResolvedValueOnce(false)
    await clickLabel('page:readme.md')
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="page"]')).not.toBeNull()
    expect(shared.importFile).not.toHaveBeenCalled()
})

it('gives a new page the same files and opener', async () => {
    await mount()
    await clickLabel('New page')
    expect(document.querySelector('[data-testid="new-page"]')?.getAttribute('data-files')).toBe('readme.md')
    expect(harness.seen.newer?.onOpenFile).toBe(harness.seen.page?.onOpenFile)
    await clickLabel('newer:missing.md')
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    await clickLabel('newer:readme.md')
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('readme.md')
    expect(shared.importFile).not.toHaveBeenCalled()
})

it('opens a file chip from version history through the same check', async () => {
    await mount()
    await clickLabel('Open history')
    expect(document.querySelector('[data-testid="history"]')?.getAttribute('data-files')).toBe('')
    expect(harness.seen.history?.files).toBeUndefined()
    expect(harness.seen.history?.onOpenFile).toBe(harness.seen.page?.onOpenFile)
    await clickLabel('history:../secret.md')
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    await clickLabel('history:readme.md')
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('readme.md')
    expect(shared.importFile).not.toHaveBeenCalled()
})
