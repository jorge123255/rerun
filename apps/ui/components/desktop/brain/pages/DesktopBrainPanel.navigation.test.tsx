// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { DesktopBrainRequestError } from '@/lib/desktop/brain-pages'
import { DesktopBrainPanel } from './DesktopBrainPanel'
import type { DesktopBrainActions } from './types'

const drafts = vi.hoisted(() => ({ flush: vi.fn(async () => true) }))
const shared = vi.hoisted(() => ({
    list: vi.fn(async (path: string) => ({ path, entries: [], truncated: false })),
    importFile: vi.fn(async () => ({ path: 'readme.md', name: 'readme.md' })),
}))
const tables = vi.hoisted(() => ({ list: vi.fn(async () => [{ name: 'alpha', columns: [] }, { name: 'orders', columns: [] }]) }))

vi.mock('@/lib/desktop/use-brain-page-draft', () => ({ flushDesktopBrainDrafts: drafts.flush, forgetBrainDraft: vi.fn(), brainDraftHash: vi.fn(() => null) }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: shared.list, importDesktopSharedFile: shared.importFile }))
vi.mock('@/lib/desktop/data-source', () => ({ desktopDataSource: () => ({ listTables: tables.list }) }))
vi.mock('@/components/brain/editor/file-link', () => ({ SHARED_FILE_DRAG_TYPE: 'application/x-rerun-shared-file' }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ stepKey, depth, children }: { stepKey: string; depth: number; children: ReactNode }) => <div data-testid="steps" data-step={stepKey} data-depth={String(depth)}>{children}</div> }))
vi.mock('@/components/data/DataBrowser', () => ({ DataBrowser: ({ table, initial }: { table?: string; initial?: { view?: string } | null }) => <div data-testid="data-browser" data-table={table ?? ''} data-view={initial?.view ?? ''} /> }))
vi.mock('@/components/desktop/shared-files/DesktopSharedFilePreview', () => ({
    DesktopSharedFilePreview: ({ path, onOpen }: { path: string; onOpen: (path: string, directory: boolean) => void }) => (
        <div>
            <div data-testid="file-preview">{path}</div>
            <button type="button" onClick={() => onOpen(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', true)}>Back to folder</button>
        </div>
    ),
}))
vi.mock('./DesktopBrainPage', () => ({ DesktopBrainPage: ({ onHistory }: { onHistory: () => void }) => <button type="button" onClick={onHistory}>Open history</button> }))
vi.mock('./DesktopBrainHistory', () => ({ DesktopBrainHistory: ({ onBack }: { onBack: () => void }) => <button type="button" onClick={onBack}>Back to page</button> }))
vi.mock('./DesktopBrainNewPage', () => ({ DesktopBrainNewPage: () => <div>New page form</div> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }) })
}

const summary = { slug: 'pricing', title: 'Pricing', type: 'note' as const, hash: 'a'.repeat(32), updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'user:1' }
const detail = { page: { ...summary, content: 'Price', sources: [], unconfirmed: [], links: [], backlinks: [] }, revisions: [] }
const listings: Record<string, ReturnType<SharedFilesTree['entriesOf']>> = {
    '': [
        { name: 'notes', type: 'dir', size: 0, modified: '' },
        { name: 'readme.md', type: 'file', size: 12, modified: '' },
    ],
}
const entriesOf = vi.fn((dir: string) => listings[dir])
const files: SharedFilesTree = { entriesOf, expanded: new Set<string>(), toggle: vi.fn(), expand: vi.fn(), refresh: vi.fn(async () => {}), knownFiles: [{ path: 'readme.md', name: 'readme.md' }] }

let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    drafts.flush.mockReset().mockResolvedValue(true)
    shared.importFile.mockClear()
    entriesOf.mockClear()
    tables.list.mockReset().mockResolvedValue([{ name: 'alpha', columns: [] }, { name: 'orders', columns: [] }])
})

function actionsFor(load: () => Promise<unknown> = async () => ({ pages: [summary], openProposals: 0 })): DesktopBrainActions {
    return { load: vi.fn(load), readPage: vi.fn(async () => detail), savePage: vi.fn(), deletePage: vi.fn(), readRevision: vi.fn(), revertPage: vi.fn(), confirmSections: vi.fn() } as unknown as DesktopBrainActions
}

async function settle() {
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function mount(actions: DesktopBrainActions, extra: Partial<ComponentProps<typeof DesktopBrainPanel>> = {}) {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => { root!.render(<DesktopBrainPanel actions={actions} onClose={() => {}} files={files} renderProposals={() => <div>Review proposals</div>} {...extra} />) })
    await settle()
}

function labels(scope: string) {
    return [...document.querySelectorAll(`${scope} [role="button"],${scope} button`)].map(node => (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
}

async function click(scope: string, label: string) {
    const host = document.querySelector(scope)
    const target = [...(host?.querySelectorAll<HTMLElement>('[role="button"],button') ?? [])].find(node => (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim() === label)
    if (!target) throw new Error(`missing ${label}`)
    await act(async () => { target.click() })
    await settle()
}

function step() {
    return document.querySelector('[data-testid="steps"]')
}

it('lists proposals, a page, a folder and a table in the original sidebar order', async () => {
    await mount(actionsFor())
    const names = labels('aside')
    const at = (label: string) => names.indexOf(label)
    expect(at('Proposals')).toBeGreaterThanOrEqual(0)
    expect(at('Proposals')).toBeLessThan(at('Pricing'))
    expect(at('Pricing')).toBeLessThan(at('Files'))
    expect(at('Files')).toBeLessThan(at('readme.md'))
    expect(at('readme.md')).toBeLessThan(at('Database'))
    expect(at('Database')).toBeLessThan(at('Alpha'))
    expect(document.querySelector('aside [draggable="true"]')).toBeNull()
})

it('does not read a page again when that page is already open, and flushes the draft first', async () => {
    const order: string[] = []
    drafts.flush.mockImplementation(async () => { order.push('flush'); return true })
    const actions = actionsFor()
    actions.readPage = vi.fn(async () => { order.push('read'); return detail }) as DesktopBrainActions['readPage']
    await mount(actions)
    expect(order).toEqual(['flush', 'read'])
    await click('aside', 'Pricing')
    expect(actions.readPage).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['flush', 'read'])
})

it('keeps the current page open when saving its draft fails before switching to Files', async () => {
    await mount(actionsFor())
    drafts.flush.mockResolvedValueOnce(false)
    await click('aside', 'Files')
    expect(document.querySelector('main')?.textContent).toContain('Open history')
    drafts.flush.mockResolvedValueOnce(true)
    await click('aside', 'Files')
    expect(document.querySelector('main')?.textContent).not.toContain('Open history')
})

it('keeps a selection that was made before the overview arrives', async () => {
    let release: (value: { pages: typeof summary[]; openProposals: number }) => void = () => {}
    const actions = actionsFor(() => new Promise(resolve => { release = resolve }))
    await mount(actions, { openSlug: 'pricing' })
    expect(actions.readPage).toHaveBeenCalledTimes(1)
    expect(actions.readPage).toHaveBeenCalledWith('pricing')
    await act(async () => { release({ pages: [{ ...summary, slug: 'voice', title: 'Voice' }], openProposals: 0 }); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(actions.readPage).toHaveBeenCalledTimes(1)
    expect(document.querySelector('main')?.textContent).toContain('Open history')
})

it('lets a table route win over a page open', async () => {
    const actions = actionsFor()
    await mount(actions, { openSlug: 'pricing', route: { selection: { kind: 'page', slug: 'pricing' }, data: { table: 'orders', view: 'board' } } })
    expect(actions.readPage).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="data-browser"]')?.getAttribute('data-table')).toBe('orders')
    expect(document.querySelector('[data-testid="data-browser"]')?.getAttribute('data-view')).toBe('board')
    expect(step()?.getAttribute('data-step')).toBe('table:orders')
})

it('returns from history to the same page without reading it again', async () => {
    const actions = actionsFor()
    await mount(actions)
    expect(step()?.getAttribute('data-depth')).toBe('0')
    await click('main', 'Open history')
    expect(actions.readPage).toHaveBeenCalledTimes(1)
    expect(step()?.getAttribute('data-step')).toBe('history:pricing')
    expect(step()?.getAttribute('data-depth')).toBe('1')
    await click('main', 'Back to page')
    expect(actions.readPage).toHaveBeenCalledTimes(1)
    expect(document.querySelector('main')?.textContent).toContain('Open history')
    expect(step()?.getAttribute('data-depth')).toBe('0')
})

it('focuses the sidebar search on ⌘K', async () => {
    await mount(actionsFor())
    const input = document.querySelector('input[aria-label="Search pages and files"]') as HTMLInputElement
    input.blur()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(input)
})

it('opens a shared folder from the injected tree and does not import', async () => {
    const actions = actionsFor()
    await mount(actions, { route: { selection: { kind: 'folder', path: '' } } })
    expect(entriesOf).toHaveBeenCalledWith('')
    expect(document.querySelector('main h1')?.textContent).toBe('Files')
    expect(document.querySelector('main')?.textContent).toContain('readme.md')
    expect(shared.importFile).not.toHaveBeenCalled()
    expect(actions.readPage).not.toHaveBeenCalled()
    await click('aside', 'readme.md')
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('readme.md')
    expect(step()?.getAttribute('data-step')).toBe('file:readme.md')
    await click('main', 'Back to folder')
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(document.querySelector('main h1')?.textContent).toBe('Files')
    expect(shared.importFile).not.toHaveBeenCalled()
    expect(actions.readPage).not.toHaveBeenCalled()
})

it('opens the first shared table when the database is selected', async () => {
    const actions = actionsFor()
    await mount(actions, { route: { selection: { kind: 'database' } } })
    expect(document.querySelector('[data-testid="data-browser"]')?.getAttribute('data-table')).toBe('alpha')
    expect(actions.readPage).not.toHaveBeenCalled()
    await click('aside', 'Proposals')
    expect(document.querySelector('main')?.textContent).toContain('Review proposals')
    await click('aside', 'Pricing')
    expect(document.querySelector('main')?.textContent).toContain('Open history')
})

it('keeps files and the database when the Brain pages route is missing', async () => {
    const actions = actionsFor(async () => { throw new DesktopBrainRequestError(404, 'Brain page or revision not found.') })
    await mount(actions)
    expect(document.querySelector('aside')).not.toBeNull()
    expect(document.body.textContent).toContain('Not on this box yet')
    expect(labels('aside')).toContain('Files')
    expect(labels('aside')).toContain('Database')
    expect(document.body.textContent).toContain('readme.md')
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).not.toContain('This machine does not have the Brain yet')
    expect(document.querySelector('main h1')?.textContent).toBe('Files')
})

it('hides the sidebar when the workspace is unreachable or has no machine', async () => {
    await mount(actionsFor(async () => { throw new Error('down') }))
    expect(document.querySelector('aside')).toBeNull()
    expect(document.body.textContent).toContain('Could not reach your workspace')
    await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    await mount(actionsFor(async () => ({ available: false, reason: 'no_machine' })))
    expect(document.querySelector('aside')).toBeNull()
    expect(document.body.textContent).toContain('Your Brain comes with your first coworker')
})
