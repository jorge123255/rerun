// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { flushDesktopBrainDrafts } from '@/lib/desktop/use-brain-page-draft'
import { DesktopBrainNewPage } from './DesktopBrainNewPage'

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
    PageTitle: ({ value }: { value: string }) => <div>{value}</div>,
}))
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

const files = [{ path: 'readme.md', name: 'readme.md' }]
let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    state.clear()
    document.body.innerHTML = ''
})

async function mount(onOpenFile = vi.fn()) {
    const actions = { savePage: vi.fn(), readPage: vi.fn() }
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => {
        root!.render(<DesktopBrainNewPage pages={[]} titles={new Map()} actions={actions} files={files} onOpenPage={vi.fn()} onOpenFile={onOpenFile} onCreated={vi.fn()} />)
    })
    return actions
}

it('keeps an inserted shared-file link in the new-page draft and does not create the page', async () => {
    const actions = await mount()
    expect(document.querySelector('[data-testid="files"]')?.textContent).toBe('readme.md')
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Insert file')!.click() })
    await act(async () => { expect(await flushDesktopBrainDrafts()).toBe(true) })
    await act(async () => root!.unmount())
    root = undefined
    await mount()
    expect(document.querySelector('[data-testid="body"]')?.textContent).toBe('[readme.md](shared:readme.md)')
    expect(actions.savePage).not.toHaveBeenCalled()
})

it('opens a file link through the handler it was given', async () => {
    const onOpenFile = vi.fn()
    const actions = await mount(onOpenFile)
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Open file')!.click() })
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onOpenFile).toHaveBeenCalledWith('readme.md')
    expect(actions.savePage).not.toHaveBeenCalled()
})
