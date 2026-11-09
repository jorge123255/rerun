// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { flushDesktopBrainDrafts } from '@/lib/desktop/use-brain-page-draft'
import { DesktopBrainNewPage } from './DesktopBrainNewPage'

const seen = vi.hoisted(() => ({ accept: undefined as undefined | ((raw: string) => unknown) }))
const state = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/desktop/brain-ui-state', () => ({
    readBrainUiState: (key: string) => state.get(key) ?? null,
    writeBrainUiState: async (key: string, value: unknown) => { state.set(key, structuredClone(value)) },
    flushBrainUiState: async () => true,
}))
vi.mock('@/lib/desktop/draft-writes', () => ({ holdDraftAdmission: () => () => {}, subscribeDraftShutdown: () => () => {} }))
vi.mock('@/components/brain/BrainTopBar', () => ({ BrainTopBar: () => null }))
vi.mock('@/components/brain/BrainPageParts', () => ({
    PageColumn: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    PageProperty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    PageTypeIcon: () => null,
    PageTypeSelect: () => null,
    PageTitle: () => null,
}))
vi.mock('@/components/brain/editor/BrainEditor', () => ({
    BrainEditor: ({ content, onChange, onAcceptFileDrop }: { content: string; onChange?: (value: string) => void; onAcceptFileDrop?: (raw: string) => unknown }) => {
        seen.accept = onAcceptFileDrop
        return <div><span data-testid="body">{content}</span><button type="button" onClick={() => onChange?.('[readme.md](shared:readme.md)')}>Apply drop</button></div>
    },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const accept = vi.fn(() => ({ path: 'readme.md', name: 'readme.md' }))
let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    state.clear()
    document.body.innerHTML = ''
    seen.accept = undefined
})

async function mount() {
    const actions = { savePage: vi.fn(), readPage: vi.fn() }
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => {
        root!.render(<DesktopBrainNewPage pages={[]} titles={new Map()} actions={actions} files={[{ path: 'readme.md', name: 'readme.md' }]} onOpenPage={vi.fn()} onAcceptFileDrop={accept} onCreated={vi.fn()} />)
    })
    return actions
}

it('gives the new-page editor the drop check and keeps the inserted link in the draft', async () => {
    const actions = await mount()
    expect(seen.accept).toBe(accept)
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Apply drop')!.click() })
    await act(async () => { expect(await flushDesktopBrainDrafts()).toBe(true) })
    await act(async () => root!.unmount())
    root = undefined
    await mount()
    expect(document.querySelector('[data-testid="body"]')?.textContent).toBe('[readme.md](shared:readme.md)')
    expect(actions.savePage).not.toHaveBeenCalled()
})
