// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useDesktopComposerDraft } from './use-composer-draft'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts } from './draft-writes'
import type { DesktopComposerDraft } from './composer-draft'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let current: ReturnType<typeof useDesktopComposerDraft>
let agentId: string, container: HTMLDivElement, root: Root
const restored = vi.fn()
const saved = new Map<string, DesktopComposerDraft>()
let read: (uid: string) => Promise<Response>

function Probe({ uid }: { uid?: string }) {
    const value = useDesktopComposerDraft(agentId, uid, restored)
    useLayoutEffect(() => { current = value })
    return <span>{value.loaded ? value.text : 'Loading'}{value.quitting ? ' Frozen' : ''}</span>
}
const render = (uid?: string) => act(async () => { root.render(<Probe uid={uid} />) })
beforeEach(() => {
    agentId = `draft-hook-${crypto.randomUUID()}`
    restored.mockReset(); saved.clear(); cancelDraftShutdown()
    read = async uid => Response.json({ draft: saved.get(uid) ?? { revision: 0, text: '' } })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        expect(url.pathname).toBe(`/api/desktop/agents/${agentId}/draft`)
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body))
            const draft = { revision: body.baseRevision + 1, text: body.text, ...(body.attachmentPath && { attachmentPath: body.attachmentPath }) }
            saved.set(body.tabUid, draft)
            return Response.json({ draft })
        }
        return read(url.searchParams.get('tabUid')!)
    }))
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
    await act(async () => { root.unmount() })
    forgetCoworkerDrafts(agentId); cancelDraftShutdown(); container.remove(); vi.unstubAllGlobals()
})

test('restoration waits for the saved draft and does not reapply after every local edit', async () => {
    let finish!: (response: Response) => void
    read = () => new Promise(resolve => { finish = resolve })
    await render('one')
    expect(current.loaded).toBe(false)
    expect(restored).not.toHaveBeenCalled()
    await act(async () => { finish(Response.json({ draft: { revision: 3, text: 'Saved text', attachmentPath: 'notes.md' } })) })
    expect(current.loaded).toBe(true)
    expect(restored).toHaveBeenCalledExactlyOnceWith({ text: 'Saved text', attachmentPath: 'notes.md' })
    await act(async () => { current.update({ text: 'Edited text', attachmentPath: 'notes.md' }); await current.flush() })
    expect(restored).toHaveBeenCalledTimes(1)
    expect(saved.get('one')?.text).toBe('Edited text')
})

test('a late read for an old tab cannot restore into the newly selected tab', async () => {
    let finishOld!: (response: Response) => void
    read = uid => uid === 'old' ? new Promise(resolve => { finishOld = resolve })
        : Promise.resolve(Response.json({ draft: { revision: 2, text: 'New tab draft', attachmentPath: 'new.md' } }))
    await render('old'); await render('new')
    expect(restored).toHaveBeenCalledExactlyOnceWith({ text: 'New tab draft', attachmentPath: 'new.md' })
    await act(async () => { finishOld(Response.json({ draft: { revision: 4, text: 'Old tab draft' } })) })
    expect(current.text).toBe('New tab draft')
    expect(restored).toHaveBeenCalledTimes(1)
})

test('an unmounted owner still finishes its save and a fresh mount restores both text and file', async () => {
    await render('one')
    await act(async () => { current.update({ text: 'Keep after restart', attachmentPath: 'proof.md' }); root.unmount() })
    expect(await flushDesktopDrafts()).toBe(true)
    forgetCoworkerDrafts(agentId); cancelDraftShutdown(); restored.mockClear()
    root = createRoot(container)
    await render('one')
    expect(restored).toHaveBeenCalledExactlyOnceWith({ text: 'Keep after restart', attachmentPath: 'proof.md' })
})

test('reload rehydrates the selected saved version and quit remains observable until cancellation', async () => {
    saved.set('one', { revision: 1, text: 'Before' })
    await render('one')
    saved.set('one', { revision: 2, text: 'Saved replacement', attachmentPath: 'replacement.md' })
    await act(async () => { await current.reload() })
    expect(restored).toHaveBeenLastCalledWith({ text: 'Saved replacement', attachmentPath: 'replacement.md' })
    await act(async () => { expect(await flushDesktopDrafts()).toBe(true) })
    expect(current.quitting).toBe(true)
    await act(async () => { cancelDraftShutdown() })
    expect(current.quitting).toBe(false)
})

test('a caller without a persisted tab does not read or write an unrelated draft', async () => {
    await render()
    expect(current.loaded).toBe(true)
    await act(async () => { current.update({ text: 'Unbound' }); expect(await current.flush()).toBe(true) })
    expect(fetch).not.toHaveBeenCalled()
    expect(restored).not.toHaveBeenCalled()
})
