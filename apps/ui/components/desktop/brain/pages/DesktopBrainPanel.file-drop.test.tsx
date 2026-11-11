// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { SHARED_FILE_DRAG_TYPE, sharedFileDragData } from '@/components/brain/editor/file-link'
import { DesktopBrainPanel } from './DesktopBrainPanel'
import type { DesktopBrainActions } from './types'

const harness = vi.hoisted(() => {
    const seen: {
        page: null | { onAcceptFileDrop?: (raw: string) => unknown; onHistory?: () => void }
        newer: null | { onAcceptFileDrop?: (raw: string) => unknown }
        history: null | { onAcceptFileDrop?: (raw: string) => unknown; files?: unknown }
    } = { page: null, newer: null, history: null }
    return { seen }
})
function probe(kind: 'page' | 'newer' | 'history', props: { onAcceptFileDrop?: (raw: string) => unknown; onHistory?: () => void; files?: unknown }) {
    harness.seen[kind] = props
    return createElement('div', { 'data-testid': kind === 'newer' ? 'new-page' : kind },
        props.onHistory ? createElement('button', { type: 'button', onClick: props.onHistory }, 'Open history') : null,
    )
}
const drafts = vi.hoisted(() => ({ flush: vi.fn(async () => true) }))
const shared = vi.hoisted(() => ({
    list: vi.fn(async (path: string) => ({ path, entries: [], truncated: false })),
    importFile: vi.fn(async () => ({ path: 'readme.md', name: 'readme.md' })),
}))

vi.mock('@/lib/desktop/use-brain-page-draft', () => ({ flushDesktopBrainDrafts: drafts.flush, forgetBrainDraft: vi.fn(), brainDraftHash: vi.fn(() => null) }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ listDesktopSharedFolder: shared.list, importDesktopSharedFile: shared.importFile }))
vi.mock('@/lib/desktop/data-source', () => ({ desktopDataSource: () => ({ listTables: vi.fn(async () => []) }) }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/data/DataBrowser', () => ({ DataBrowser: () => null }))
vi.mock('@/components/desktop/shared-files/DesktopSharedFilePreview', () => ({ DesktopSharedFilePreview: () => null }))
vi.mock('./DesktopBrainPage', () => ({ DesktopBrainPage: (props: { onAcceptFileDrop?: (raw: string) => unknown; onHistory: () => void }) => probe('page', props) }))
vi.mock('./DesktopBrainNewPage', () => ({ DesktopBrainNewPage: (props: { onAcceptFileDrop?: (raw: string) => unknown }) => probe('newer', props) }))
vi.mock('./DesktopBrainHistory', () => ({ DesktopBrainHistory: (props: { onAcceptFileDrop?: (raw: string) => unknown; files?: unknown }) => probe('history', props) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }) })
}

const summary = { slug: 'pricing', title: 'Pricing', type: 'note' as const, hash: 'a'.repeat(32), updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'user:1' }
const detail = { page: { ...summary, content: 'Price', sources: [], unconfirmed: [], links: [], backlinks: [] }, revisions: [] }
const files: SharedFilesTree = {
    entriesOf: dir => dir === '' ? [
        { name: 'notes', type: 'dir', size: 0, modified: '' },
        { name: 'readme.md', type: 'file', size: 12, modified: '' },
    ] : [],
    expanded: new Set<string>(),
    toggle: () => {},
    expand: () => {},
    refresh: async () => {},
    knownFiles: [
        { path: 'readme.md', name: 'readme.md' },
        { path: '../secret.md', name: 'secret.md' },
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

async function mount(workspaceId?: number | null) {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => { root!.render(<DesktopBrainPanel actions={actionsFor()} onClose={() => {}} files={files} workspaceId={workspaceId} />) })
    await settle()
}

function row(label: string) {
    return [...document.querySelectorAll<HTMLElement>('aside [role="button"]')].find(node => (node.textContent || '').replace(/\s+/g, ' ').trim() === label)
}

function drag(node: HTMLElement) {
    const store = new Map<string, string>()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
        value: {
            effectAllowed: '',
            setData(type: string, value: string) { store.set(type, value) },
            getData(type: string) { return store.get(type) ?? '' },
        },
    })
    node.dispatchEvent(event)
    return store.get(SHARED_FILE_DRAG_TYPE) ?? ''
}

async function click(label: string) {
    const target = [...document.querySelectorAll<HTMLElement>('button,[role="button"]')].find(node => (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim() === label)
    if (!target) throw new Error(`missing ${label}`)
    await act(async () => { target.click() })
    await settle()
}

it('accepts a listed file from this workspace and refuses a forged drop', async () => {
    await mount(1)
    const listsBefore = shared.list.mock.calls.length
    const raw = drag(row('readme.md')!)
    expect(JSON.parse(raw)).toEqual({ path: 'readme.md', name: 'readme.md', workspace: '1' })
    expect(document.querySelector('aside [role="button"][draggable="true"]')?.textContent).toContain('readme.md')
    expect([...document.querySelectorAll('aside [draggable="true"]')].some(node => (node.textContent || '').includes('notes'))).toBe(false)
    const accept = harness.seen.page?.onAcceptFileDrop
    expect(accept?.(raw)).toEqual({ path: 'readme.md', name: 'readme.md' })
    expect(accept?.(sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '2'))).toBeNull()
    expect(accept?.('{')).toBeNull()
    expect(accept?.(sharedFileDragData({ path: '../secret.md', name: 'secret.md' }, '1'))).toBeNull()
    expect(accept?.(JSON.stringify({ path: 'notes', name: 'notes', type: 'dir', workspace: '1' }))).toBeNull()
    expect(accept?.(sharedFileDragData({ path: 'missing.md', name: 'missing.md' }, '1'))).toBeNull()
    expect(shared.importFile).not.toHaveBeenCalled()
    expect(shared.list.mock.calls.length).toBe(listsBefore)
    await click('Open history')
    expect(harness.seen.history?.onAcceptFileDrop).toBeUndefined()
    expect(harness.seen.history?.files).toBeUndefined()
    await click('New page')
    expect(harness.seen.newer?.onAcceptFileDrop).toBe(accept)
})

it('binds an omitted workspace to this mount and refuses another workspace id', async () => {
    await mount()
    const raw = drag(row('readme.md')!)
    const payload = JSON.parse(raw) as { workspace?: string }
    expect(payload.workspace).toBeTruthy()
    expect(payload.workspace).not.toBe('1')
    expect(harness.seen.page?.onAcceptFileDrop?.(raw)).toEqual({ path: 'readme.md', name: 'readme.md' })
    expect(harness.seen.page?.onAcceptFileDrop?.(sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '1'))).toBeNull()
    expect(shared.importFile).not.toHaveBeenCalled()
})

it('keeps the drag off until a workspace is confirmed', async () => {
    await mount(null)
    expect(document.querySelector('aside [draggable="true"]')).toBeNull()
    expect(harness.seen.page?.onAcceptFileDrop?.(sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '1'))).toBeNull()
    expect(shared.importFile).not.toHaveBeenCalled()
})
