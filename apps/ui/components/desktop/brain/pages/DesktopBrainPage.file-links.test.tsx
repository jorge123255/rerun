// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrainActions } from './types'
import { DesktopBrainPage } from './DesktopBrainPage'

const draft = vi.hoisted(() => ({ edit: vi.fn(), flush: vi.fn(async () => {}) }))
vi.mock('@/lib/desktop/brain-ui-state', () => ({ readBrainUiState: () => null, writeBrainUiState: async () => {}, flushBrainUiState: async () => true }))
vi.mock('@/lib/desktop/use-brain-page-draft', () => ({
    brainDraftFor: (page: { title: string; type: string; content: string }) => ({ title: page.title, type: page.type, content: page.content }),
    brainDraftHash: () => null,
    flushDesktopBrainDrafts: vi.fn(async () => true),
    useBrainPageDraft: () => ({ status: 'idle', error: null, conflictWith: null, edit: draft.edit, flush: draft.flush, loadTheirs: vi.fn(), keepMine: vi.fn() }),
}))
vi.mock('@/components/brain/BrainTopBar', () => ({ BrainTopBar: () => null }))
vi.mock('@/components/brain/BrainPageParts', () => ({
    PageColumn: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    PageProperty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    PageTitle: () => null,
    PageTypeIcon: () => null,
    PageTypeSelect: () => null,
    UnconfirmedSections: () => null,
}))
vi.mock('@/components/dialogs/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/components/brain/editor/BrainEditor', () => ({
    BrainEditor: ({ content, files, onChange, onOpenFile }: { content: string; files?: { path: string }[]; onChange?: (value: string) => void; onOpenFile?: (path: string) => void }) => (
        <div>
            <span data-testid="body">{content}</span>
            <span data-testid="files">{(files ?? []).map(file => file.path).join('|')}</span>
            <button type="button" onClick={() => onChange?.('[readme.md](shared:readme.md)')}>Insert file</button>
            <button type="button" onClick={() => onOpenFile?.('readme.md')}>Open file</button>
        </div>
    ),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const page = {
    slug: 'pricing', title: 'Pricing', type: 'note' as const, hash: 'a'.repeat(32), updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'user:1',
    content: 'Price', sources: [], unconfirmed: [], links: [], backlinks: [],
}
const files = [{ path: 'readme.md', name: 'readme.md' }]
const actions = { savePage: vi.fn(), readPage: vi.fn(), deletePage: vi.fn(), load: vi.fn(), readRevision: vi.fn(), revertPage: vi.fn(), confirmSections: vi.fn() } as unknown as DesktopBrainActions

let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    draft.edit.mockClear()
    draft.flush.mockClear()
})

async function mount(content = page.content) {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    const onOpenFile = vi.fn()
    await act(async () => {
        root!.render(<DesktopBrainPage detail={{ page: { ...page, content }, revisions: [] }} pages={[]} titles={new Map()} actions={actions} files={files} onOpenPage={vi.fn()} onOpenFile={onOpenFile} onSaved={vi.fn()} onHistory={vi.fn()} onDeleted={vi.fn()} />)
    })
    return onOpenFile
}

it('gives the page editor the listed files and stores a shared-file link through the existing draft edit', async () => {
    await mount()
    expect(document.querySelector('[data-testid="files"]')?.textContent).toBe('readme.md')
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Insert file')!.click() })
    expect(document.querySelector('[data-testid="body"]')?.textContent).toBe('[readme.md](shared:readme.md)')
    expect(draft.edit).toHaveBeenCalledWith({ content: '[readme.md](shared:readme.md)' })
    expect(actions.savePage).not.toHaveBeenCalled()
})

it('opens a file link through the handler it was given', async () => {
    const onOpenFile = await mount()
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Open file')!.click() })
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onOpenFile).toHaveBeenCalledWith('readme.md')
    expect(draft.edit).not.toHaveBeenCalled()
})

it('shows a saved shared-file link again when the page is reopened', async () => {
    await mount('[readme.md](shared:readme.md)')
    expect(document.querySelector('[data-testid="body"]')?.textContent).toBe('[readme.md](shared:readme.md)')
    expect(document.querySelector('[data-testid="files"]')?.textContent).toBe('readme.md')
    expect(draft.edit).not.toHaveBeenCalled()
})
