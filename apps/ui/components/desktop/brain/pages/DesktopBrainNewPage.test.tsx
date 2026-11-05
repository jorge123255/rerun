// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopBrainNewPage } from './DesktopBrainNewPage'
import { flushDesktopBrainDrafts } from '@/lib/desktop/use-brain-page-draft'
const state = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/desktop/brain-ui-state', () => ({ readBrainUiState: (key: string) => state.get(key) ?? null,
    writeBrainUiState: async (key: string, value: unknown) => { state.set(key, structuredClone(value)) }, flushBrainUiState: async () => true }))
vi.mock('@/lib/desktop/draft-writes', () => ({ holdDraftAdmission: () => () => {}, subscribeDraftShutdown: () => () => {} }))
vi.mock('@/components/brain/BrainTopBar', () => ({ BrainTopBar: () => null }))
vi.mock('@/components/brain/BrainPageParts', () => ({ PageColumn: ({ children }: { children: ReactNode }) => <div>{children}</div>, PageProperty: ({ children }: { children: ReactNode }) => <div>{children}</div>, PageTypeIcon: () => null, PageTypeSelect: () => null,
    PageTitle: ({ value }: { value: string }) => <div>{value}</div> }))
vi.mock('@/components/brain/editor/BrainEditor', () => ({ BrainEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => <div><span data-testid="body">{content}</span><button onClick={() => onChange('Unfinished body without a title')}>Type body</button></div> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; state.clear(); document.body.innerHTML = '' })
it('persists an unnamed new-page body on close and restores it when reopened without creating a page', async () => {
    const actions = { savePage: vi.fn(), readPage: vi.fn() }
    const mount = async () => { const node = document.createElement('div'); document.body.append(node); root = createRoot(node)
        await act(async () => root!.render(<DesktopBrainNewPage pages={[]} titles={new Map()} actions={actions} onOpenPage={vi.fn()} onCreated={vi.fn()} />)) }
    await mount()
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Type body')!.click() })
    await act(async () => { expect(await flushDesktopBrainDrafts()).toBe(true) })
    await act(async () => root!.unmount()); root = undefined
    await mount()
    expect(document.querySelector('[data-testid="body"]')?.textContent).toBe('Unfinished body without a title')
    expect(actions.savePage).not.toHaveBeenCalled()
})
