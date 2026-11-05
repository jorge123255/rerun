// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainPage } from '@rerun/contracts'
import { forgetBrainDraft, flushDesktopBrainDrafts, useBrainPageDraft, type BrainDraftActions } from './use-brain-page-draft'
const state = vi.hoisted(() => ({ store: new Map<string, unknown>(), writes: [] as { key: string; value: unknown }[], failConfirmed: false, failIntentClear: false }))
const store = state.store
vi.mock('./brain-ui-state', () => ({ readBrainUiState: (key: string) => store.get(key) ?? null,
    writeBrainUiState: async (key: string, value: unknown) => {
        state.writes.push({ key, value: structuredClone(value) })
        if (state.failConfirmed && key.startsWith('draft:') && value && typeof value === 'object' && 'baseHash' in value && value.baseHash === 'b'.repeat(32) && 'dirty' in value && value.dirty === false) throw new Error('Confirmed hash persistence failed')
        if (state.failIntentClear && key.startsWith('intent:save:') && value === null) throw new Error('Intent clear response lost')
        store.set(key, structuredClone(value))
    }, flushBrainUiState: async () => true }))
vi.mock('@/lib/desktop/draft-writes', () => ({ holdDraftAdmission: () => () => {}, subscribeDraftShutdown: () => () => {} }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let current: ReturnType<typeof useBrainPageDraft>
const pages: string[] = []
const page = (slug: string): BrainPage => ({ slug, title: 'Company', type: 'company', content: 'Original', sources: [], hash: 'a'.repeat(32),
    updatedAt: '', updatedBy: 'user:local', unconfirmed: [], links: [], backlinks: [] })
function Harness({ value, actions }: { value: BrainPage; actions: BrainDraftActions }) {
    const draft = useBrainPageDraft({ page: value, actions, onSaved: () => {} })
    useEffect(() => { current = draft }, [draft])
    return <div>{draft.draft.content} {draft.status}</div>
}
async function mount(value: BrainPage, actions: BrainDraftActions) {
    pages.push(value.slug)
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node)
    await act(async () => { root!.render(<Harness value={value} actions={actions} />) })
}
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    for (const slug of pages.splice(0)) forgetBrainDraft(slug)
    store.clear(); state.writes.length = 0; state.failConfirmed = false; state.failIntentClear = false; document.body.innerHTML = ''; vi.clearAllMocks()
})
it('replays the same save after remount before admitting later edits', async () => {
    const value = page('retry-draft')
    const savePage = vi.fn().mockResolvedValueOnce({ ok: false, conflict: false, uncertain: true, error: 'Reply lost' })
        .mockResolvedValueOnce({ ok: true, detail: { page: { ...value, content: 'First', hash: 'b'.repeat(32) }, revisions: [] } })
        .mockResolvedValueOnce({ ok: true, detail: { page: { ...value, content: 'Second', hash: 'c'.repeat(32) }, revisions: [] } })
    const actions = { savePage, readPage: vi.fn() }
    await mount(value, actions)
    await act(async () => { current.edit({ content: 'First' }); await current.flush() })
    const original = savePage.mock.calls[0]
    await act(async () => root!.unmount()); root = undefined
    await mount(value, actions)
    await act(async () => { current.edit({ content: 'Second' }); await current.flush() })
    expect(savePage.mock.calls[1]).toEqual(original)
    expect(savePage.mock.calls[2]![1]).toMatchObject({ content: 'Second', baseHash: 'b'.repeat(32) })
    expect(savePage.mock.calls[2]![2]).not.toBe(original![2])
    expect(current.status).toBe('saved')
})
it('a failed conflict read never becomes a create with a null base hash', async () => {
    const value = page('conflict-draft')
    const savePage = vi.fn().mockResolvedValue({ ok: false, conflict: true, uncertain: false, error: 'Changed' })
    const actions = { savePage, readPage: vi.fn().mockRejectedValue(new Error('Storage unavailable')) }
    await mount(value, actions)
    await act(async () => { current.edit({ content: 'Keep this' }); await current.flush() })
    await act(async () => { await current.keepMine() })
    expect(savePage).toHaveBeenCalledTimes(1)
    expect(current.draft.content).toBe('Keep this')
    expect(current.status).toBe('conflict')
    expect(current.error).toBe('Storage unavailable')
    await act(async () => { expect(await flushDesktopBrainDrafts()).toBe(false) })
})
it('a proposal refresh preserves a dirty draft and its reviewed base', async () => {
    const value = page('refresh-draft')
    const actions = { savePage: vi.fn().mockResolvedValue({ ok: false, conflict: true, uncertain: false, error: 'Changed' }), readPage: vi.fn().mockResolvedValue({ page: value, revisions: [] }) }
    await mount(value, actions)
    await act(async () => { current.edit({ content: 'Unsaved local text' }) })
    await act(async () => { root!.render(<Harness value={{ ...value, content: 'Proposal text', hash: 'b'.repeat(32) }} actions={actions} />) })
    expect(current.draft.content).toBe('Unsaved local text')
    await act(async () => { await current.flush() })
    expect(actions.savePage.mock.calls[0]![1]).toMatchObject({ baseHash: 'a'.repeat(32), content: 'Unsaved local text' })
})

it('retains the exact save identity when persisting its successful hash fails, then retries that identity', async () => {
    const value = page('receipt-order')
    const savePage = vi.fn().mockResolvedValue({ ok: true, detail: { page: { ...value, content: 'Saved content', hash: 'b'.repeat(32) }, revisions: [] } })
    const actions = { savePage, readPage: vi.fn() }
    await mount(value, actions)
    state.failConfirmed = true
    await act(async () => { current.edit({ content: 'Saved content' }); await current.flush() })
    const original = savePage.mock.calls[0]!
    expect(current.status).toBe('error')
    expect(store.get('intent:save:receipt-order')).toMatchObject({ requestId: original[2] })
    expect(state.writes.some(write => write.key === 'intent:save:receipt-order' && write.value === null)).toBe(false)
    state.failConfirmed = false
    await act(async () => { await current.flush() })
    expect(savePage.mock.calls[1]).toEqual(original)
    expect(current.status).toBe('saved')
    expect(store.get('intent:save:receipt-order')).toBeNull()
    expect(store.get('draft:receipt-order')).toBeNull()
})
it('persists the returned page hash before clearing the intent, so an interrupted clear stays replayable', async () => {
    const value = page('clear-order')
    const savePage = vi.fn().mockResolvedValue({ ok: true, detail: { page: { ...value, content: 'Saved content', hash: 'b'.repeat(32) }, revisions: [] } })
    await mount(value, { savePage, readPage: vi.fn() })
    state.failIntentClear = true
    await act(async () => { current.edit({ content: 'Saved content' }); await current.flush() })
    const original = savePage.mock.calls[0]!
    const clearIndex = state.writes.findIndex(write => write.key === 'intent:save:clear-order' && write.value === null)
    expect(clearIndex).toBeGreaterThan(0)
    expect(state.writes.slice(0, clearIndex).filter(write => write.key === 'draft:clear-order').at(-1)?.value).toMatchObject({ baseHash: 'b'.repeat(32), dirty: false })
    expect(store.get('intent:save:clear-order')).toMatchObject({ requestId: original[2] })
    state.failIntentClear = false
    await act(async () => { await current.flush() })
    expect(savePage.mock.calls[1]).toEqual(original)
    expect(current.status).toBe('saved')
})
