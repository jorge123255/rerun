// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrainActions } from './types'
import { DesktopBrainPage } from './DesktopBrainPage'

const seen = vi.hoisted(() => ({ accept: undefined as undefined | ((raw: string) => unknown) }))
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
    BrainEditor: ({ onChange, onAcceptFileDrop }: { onChange?: (value: string) => void; onAcceptFileDrop?: (raw: string) => unknown }) => {
        seen.accept = onAcceptFileDrop
        return <button type="button" onClick={() => onChange?.('[readme.md](shared:readme.md)')}>Apply drop</button>
    },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const page = {
    slug: 'pricing', title: 'Pricing', type: 'note' as const, hash: 'a'.repeat(32), updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'user:1',
    content: 'Price', sources: [], unconfirmed: [], links: [], backlinks: [],
}
const actions = { savePage: vi.fn(), readPage: vi.fn(), deletePage: vi.fn(), load: vi.fn(), readRevision: vi.fn(), revertPage: vi.fn(), confirmSections: vi.fn() } as unknown as DesktopBrainActions
const accept = vi.fn(() => ({ path: 'readme.md', name: 'readme.md' }))

let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    seen.accept = undefined
    draft.edit.mockClear()
})

it('gives the page editor the drop check and stores the inserted link through the existing draft', async () => {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => {
        root!.render(<DesktopBrainPage detail={{ page, revisions: [] }} pages={[]} titles={new Map()} actions={actions} files={[{ path: 'readme.md', name: 'readme.md' }]} onOpenPage={vi.fn()} onAcceptFileDrop={accept} onSaved={vi.fn()} onHistory={vi.fn()} onDeleted={vi.fn()} />)
    })
    expect(seen.accept).toBe(accept)
    await act(async () => { document.querySelector('button')!.click() })
    expect(draft.edit).toHaveBeenCalledWith({ content: '[readme.md](shared:readme.md)' })
    expect(actions.savePage).not.toHaveBeenCalled()
})
