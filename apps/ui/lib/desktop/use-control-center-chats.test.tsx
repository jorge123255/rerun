// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useDesktopControlCenterChats } from './use-control-center-chats'
import { queueTabWrite } from './tab-writes'
import type { DesktopControlCenterChats } from './control-center-chats'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement, current: ReturnType<typeof useDesktopControlCenterChats>
const data = (agentId: string, title = agentId): DesktopControlCenterChats => ({
    agentId, openChats: [{ agentId, tabUid: `${agentId}-tab`, sessionId: null, title }], recentChats: [], recentStatus: 'ok', hasMore: false,
})
function Probe({ agentId, active, scope }: { agentId: string; active: boolean; scope: string }) {
    const value = useDesktopControlCenterChats(agentId, active, scope)
    useLayoutEffect(() => { current = value })
    return <span>{value.loading ? 'Loading' : value.failed ? 'Failed' : value.data?.agentId}</span>
}
const render = (agentId = 'ada', active = true, scope = agentId) => act(async () => { root.render(<Probe agentId={agentId} active={active} scope={scope} />) })
beforeEach(() => { container = document.body.appendChild(document.createElement('div')); root = createRoot(container) })
afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('loads only the active blank coworker page and waits for every queued tab write before reading', async () => {
    let finishFirst!: () => void, finishSecond!: () => void
    const first = queueTabWrite('ada', () => new Promise<void>(resolve => { finishFirst = resolve }))
    const fetcher = vi.fn(async () => Response.json(data('ada')))
    vi.stubGlobal('fetch', fetcher)
    await render('ada', false)
    expect(fetcher).not.toHaveBeenCalled()
    await render()
    expect(current.loading).toBe(true)
    const second = queueTabWrite('ada', () => new Promise<void>(resolve => { finishSecond = resolve }))
    await act(async () => { finishFirst(); await first })
    expect(fetcher).not.toHaveBeenCalled()
    await act(async () => { finishSecond(); await second })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/desktop/agents/ada/control-center-chats', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }))
    expect(current.data?.openChats[0].sessionId).toBeNull()
})

test('late old-owner reads and retained refresh callbacks cannot affect the current owner', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
        .mockResolvedValue(Response.json(data('bob')))
    vi.stubGlobal('fetch', fetcher)
    await render('ada')
    const oldRefresh = current.refresh
    await render('bob')
    expect(current.data?.agentId).toBe('bob')
    await act(async () => { finish(Response.json(data('ada'))); await oldRefresh() })
    expect(current.data?.agentId).toBe('bob')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
})

test('returning to the same blank page requires a fresh read instead of reusing its prior snapshot', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(data('ada', 'Old blank')))
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    await render()
    expect(current.data?.openChats[0].title).toBe('Old blank')
    await render('ada', false)
    await render()
    expect(current.loading).toBe(true)
    expect(current.data).toBeUndefined()
    await act(async () => { finish(Response.json(data('ada', 'Fresh blank'))) })
    expect(current.data?.openChats[0].title).toBe('Fresh blank')
})

test('rejects foreign-owned snapshots and deduplicates open UIDs, saved sessions and recent overlaps', async () => {
    const base = data('ada')
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...base, openChats: data('bob').openChats }))
        .mockResolvedValueOnce(Response.json({ ...base, openChats: [
            base.openChats[0], base.openChats[0],
            { agentId: 'ada', tabUid: 'saved', sessionId: 's1', title: 'Saved' },
            { agentId: 'ada', tabUid: 'same-session', sessionId: 's1', title: 'Duplicate saved' },
        ], recentChats: [
            { id: 's1', agentId: 'ada', agentName: 'Ada', title: 'Already open' },
            { id: 's2', agentId: 'ada', agentName: 'Ada', title: 'Recent' },
            { id: 's2', agentId: 'ada', agentName: 'Ada', title: 'Duplicate recent' },
        ] }))
    vi.stubGlobal('fetch', fetcher)
    await render()
    expect(current.failed).toBe(true)
    expect(current.data).toBeUndefined()
    await act(async () => { await current.refresh() })
    expect(current.data?.openChats.map(chat => chat.tabUid)).toEqual(['ada-tab', 'saved'])
    expect(current.data?.recentChats.map(chat => chat.id)).toEqual(['s2'])
})

test('partial recent-history failure retains usable open chats; a full read failure is distinct from empty', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...data('ada'), recentStatus: 'unavailable' }))
        .mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 }))
        .mockResolvedValueOnce(Response.json(data('ada')))
    vi.stubGlobal('fetch', fetcher)
    await render()
    expect(current.failed).toBe(false)
    expect(current.data?.openChats).toHaveLength(1)
    expect(current.data?.recentStatus).toBe('unavailable')
    await act(async () => { await current.refresh() })
    expect(current.failed).toBe(true)
    expect(current.data).toBeUndefined()
    await act(async () => { await current.refresh() })
    expect(current.failed).toBe(false)
    expect(current.data?.openChats).toHaveLength(1)
})
