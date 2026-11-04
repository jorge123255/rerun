// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import { readTargetOf, type DesktopPendingInboxItem, type DesktopPendingReadTarget } from '@/lib/desktop/pending-inbox'
import { useDesktopPendingInbox, type DesktopPendingInboxController } from './useDesktopPendingInbox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-11-04T12:00:00.000Z'
const item = (id = 'request-one', patch: Partial<DesktopPendingInboxItem> = {}): DesktopPendingInboxItem => ({
    id, kind: 'question', agentId: 'a', agentName: 'Alice', agentEnabled: true,
    sessionId: 'chat-one', title: 'Question', summary: id, updatedAt: at, ...patch,
})
const roots: Root[] = []
let visible = true

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    visible = true
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); cancelDraftShutdown() })
    document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
})

function fixture(initial = [item()]) {
    let rows = initial
    let failWrite = false
    const writes: DesktopPendingReadTarget[][] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/desktop/pending-inbox/read') {
            const targets = JSON.parse(String(init?.body)).items as DesktopPendingReadTarget[]
            writes.push(targets)
            if (failWrite) return Response.json({}, { status: 503 })
            return Response.json({ marked: targets.length, failedIds: [] })
        }
        expect(url).toBe('/api/desktop/pending-inbox')
        return Response.json({ items: rows, unavailableAgentIds: [], checkedAt: at })
    })
    vi.stubGlobal('fetch', fetcher)
    return { writes, fetcher, setRows: (next: DesktopPendingInboxItem[]) => { rows = next }, failWrites: (next: boolean) => { failWrite = next } }
}

async function mount(active = true, ids = ['a'], observeWhileClosed = false) {
    let value!: DesktopPendingInboxController
    function Harness(props: { active: boolean; ids: string[]; observe: boolean }) {
        value = useDesktopPendingInbox(props.active, props.ids, props.observe)
        return <div>{value.items.map(row => <span key={row.id}>{row.summary}</span>)}</div>
    }
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    const render = async (nextActive = active, nextIds = ids, nextObserve = observeWhileClosed) => {
        active = nextActive; ids = nextIds; observeWhileClosed = nextObserve
        await act(async () => { root.render(<Harness active={active} ids={ids} observe={observeWhileClosed} />) })
    }
    await render()
    return { get value() { return value }, render }
}
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) }

test.each(['close and reopen', 'scope A to B to A'] as const)('old mark-one, mark-all and retry callbacks cannot revive after %s', async transition => {
    const f = fixture(); f.failWrites(true)
    const h = await mount()
    await act(async () => { h.value.markRead(h.value.items[0]) })
    expect(f.writes).toHaveLength(1)
    expect(h.value.readError).toBe(true)
    const old = h.value
    const oldItem = old.items[0]
    f.failWrites(false)
    if (transition === 'close and reopen') { await h.render(false); await h.render(true) }
    else { await h.render(true, ['b']); await h.render(true, ['a']) }
    const calls = f.fetcher.mock.calls.length
    await act(async () => { old.markRead(oldItem); old.markAllRead([oldItem]); old.retry() })
    expect(f.writes).toHaveLength(1)
    expect(f.fetcher.mock.calls).toHaveLength(calls)
    // The current lifecycle remains usable, so rejecting the old callbacks is not a blanket lock.
    await act(async () => { h.value.markRead(h.value.items[0]) })
    expect(f.writes).toEqual([[readTargetOf(oldItem)], [readTargetOf(oldItem)]])
    expect(h.value.items).toEqual([])
})

test('Quit blocks mark-one, mark-all, retry and polling before the component unmounts', async () => {
    const f = fixture(); f.failWrites(true)
    const h = await mount()
    await act(async () => { h.value.markRead(h.value.items[0]) })
    const old = h.value
    await act(async () => { await flushDesktopDrafts() })
    const calls = f.fetcher.mock.calls.length
    await act(async () => { old.markRead(old.items[0]); old.markAllRead(old.items); old.retry() })
    await tick()
    expect(f.writes).toHaveLength(1)
    expect(f.fetcher.mock.calls).toHaveLength(calls)
    await act(async () => { cancelDraftShutdown() })
    f.failWrites(false)
    await act(async () => { h.value.retry() })
    expect(f.writes).toHaveLength(2)
})

test.each([
    ['new request', { id: 'request-two' }],
    ['other owner', { agentId: 'b' }],
    ['other conversation', { sessionId: 'chat-two' }],
    ['other request kind', { kind: 'approval' }],
] satisfies [string, Partial<DesktopPendingInboxItem>][])('retry drops a failed target replaced by %s while retaining an unchanged failed target', async (_label, replacement) => {
    const first = item(), retained = item('retained', { sessionId: 'retained-chat' })
    const f = fixture([first, retained]); f.failWrites(true)
    const h = await mount(true, ['a', 'b'])
    await act(async () => { h.value.markAllRead(h.value.items) })
    expect(f.writes[0]).toEqual([readTargetOf(first), readTargetOf(retained)])
    f.setRows([item(first.id, replacement), retained]); await tick()
    f.failWrites(false)
    await act(async () => { h.value.retry() })
    expect(f.writes).toEqual([
        [readTargetOf(first), readTargetOf(retained)],
        [readTargetOf(retained)],
    ])
    expect(h.value.items.some(row => row.id === first.id || row.id === ('id' in replacement ? replacement.id : first.id))).toBe(true)
})

test('retry cannot acknowledge a failed target removed from the current roster', async () => {
    const f = fixture()
    f.failWrites(true)
    const h = await mount()
    await act(async () => { h.value.markRead(h.value.items[0]) })
    await h.render(true, ['b'])
    f.failWrites(false)
    await act(async () => { h.value.retry() })
    expect(f.writes).toHaveLength(1)
})

test('a current mark-all keeps exact request identity and excludes a new request arriving after its capture', async () => {
    const first = item(), f = fixture([first]), h = await mount()
    const captured = h.value.items
    const next = item('request-two')
    f.setRows([first, next]); await tick()
    await act(async () => { h.value.markAllRead(captured) })
    expect(f.writes).toEqual([[readTargetOf(first)]])
    expect(h.value.items.map(row => row.id)).toEqual([next.id])
})

test('closed observation refreshes arrivals but never authorizes pending read mutations', async () => {
    const f = fixture(); f.failWrites(true)
    const h = await mount(true, ['a'], true)
    await act(async () => { h.value.markRead(h.value.items[0]) })
    const old = h.value
    await h.render(false)
    f.failWrites(false)
    f.setRows([item(), item('arrived-closed')]); await tick()
    expect(h.value.items.map(row => row.id)).toEqual(['request-one', 'arrived-closed'])
    const calls = f.fetcher.mock.calls.length
    await act(async () => {
        old.markRead(old.items[0]); old.markAllRead(old.items); old.retry()
        h.value.markRead(h.value.items[0]); h.value.markAllRead(h.value.items); h.value.retry()
    })
    expect(f.writes).toHaveLength(1)
    expect(f.fetcher.mock.calls).toHaveLength(calls)
    await h.render(true)
    await act(async () => { h.value.markRead(h.value.items[1]) })
    expect(f.writes[1]).toEqual([readTargetOf(item('arrived-closed'))])
})

test('closed observation reads on mount, pauses when hidden or quitting, and default-closed does not observe', async () => {
    const f = fixture()
    const h = await mount(false)
    await tick()
    expect(f.fetcher).not.toHaveBeenCalled()
    await h.render(false, ['a'], true)
    expect(h.value.items).toHaveLength(1)
    const calls = f.fetcher.mock.calls.length
    visible = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await tick()
    expect(f.fetcher.mock.calls).toHaveLength(calls)
    visible = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(f.fetcher.mock.calls).toHaveLength(calls + 1)
    await act(async () => { await flushDesktopDrafts() })
    await tick()
    expect(f.fetcher.mock.calls).toHaveLength(calls + 1)
    expect(f.writes).toEqual([])
})
