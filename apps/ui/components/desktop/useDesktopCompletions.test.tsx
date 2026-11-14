// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopCompletionItem } from '@/lib/desktop/completed-actions'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import { useDesktopCompletions, type DesktopCompletionsController } from './useDesktopCompletions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-11-04T12:00:00.000Z'
const item = (id = 'one', patch: Partial<DesktopCompletionItem> = {}): DesktopCompletionItem => ({ id, agentId: 'a', agentName: 'Alice', agentEnabled: true, sessionId: 's1', sessionIds: ['s1'], title: id, message: id, source: 'chat', slug: null, count: 1, completedAt: at, completionIds: [id], ...patch })
const page = (items: DesktopCompletionItem[], nextCursor: string | null = null) => Response.json({ items, nextCursor, unavailableAgentIds: [], enabledAt: at, checkedAt: at })
const roots: Root[] = []
let focus = true
let visible = true
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    focus = true; visible = true
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focus)
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); cancelDraftShutdown() })
    document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
})

async function mount(active = true, ids = ['a'], session: string | null = null) {
    let value!: DesktopCompletionsController
    function Harness(props: { active: boolean; ids: string[]; session: string | null }) {
        value = useDesktopCompletions(props.active, props.ids, props.session)
        return <div>{value.items.map(row => <span key={row.id}>{row.message}</span>)}</div>
    }
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    const render = async (nextActive = active, nextIds = ids, nextSession = session) => {
        active = nextActive; ids = nextIds; session = nextSession
        await act(async () => { root.render(<Harness active={active} ids={ids} session={session} />) })
    }
    await render()
    return { get value() { return value }, render }
}
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) }

test('older raw pages merge interleaved groups by opaque IDs and retain the newest target and summary', async () => {
    const newest = item('scheduled', { source: 'schedule', slug: 'nightly', completionIds: ['new', 'shared'], count: 2, sessionIds: ['s-new', 's-new'], sessionId: 's-new', message: 'Newest result' })
    const older = item('scheduled', { source: 'schedule', slug: 'nightly', completionIds: ['shared', 'old'], count: 2, sessionIds: ['s-new', 's-old'], sessionId: 's-old', completedAt: '2026-11-04T11:00:00.000Z', message: 'Older result' })
    const fetcher = vi.fn(async (url: string) => {
        if (url === '/api/desktop/completions?before=opaque+cursor') return page([older, item('interleaved')])
        expect(url).toBe('/api/desktop/completions')
        return page([newest], 'opaque cursor')
    })
    vi.stubGlobal('fetch', fetcher)
    const h = await mount()
    await act(async () => { h.value.loadMore() })
    expect(fetcher.mock.calls[1][0]).toBe('/api/desktop/completions?before=opaque+cursor')
    const group = h.value.items.find(row => row.id === 'scheduled')!
    expect(group).toMatchObject({ count: 3, sessionId: 's-new', message: 'Newest result', completionIds: ['shared', 'old', 'new'], sessionIds: ['s-new', 's-old'] })
    expect(h.value.items.map(row => row.id)).toContain('interleaved')
    await tick()
    expect(h.value.items.find(row => row.id === 'scheduled')?.count).toBe(3)
    expect(h.value.items.map(row => row.id)).toContain('interleaved')
    expect(h.value.nextCursor).toBeNull()
})

test('an empty raw page keeps its cursor and can load a later unread row', async () => {
    const fetcher = vi.fn(async (url: string) => url.includes('?') ? page([item()]) : page([], 'after-seen'))
    vi.stubGlobal('fetch', fetcher)
    const h = await mount()
    expect(h.value.items).toEqual([]); expect(h.value.nextCursor).toBe('after-seen')
    await act(async () => { h.value.loadMore() })
    expect(h.value.items).toHaveLength(1); expect(h.value.nextCursor).toBeNull()
})

test('a visible conversation polls and acknowledges while the inbox is closed, and hiding preserves arrivals', async () => {
    let rows = [item()]
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/read')) { writes.push(JSON.parse(String(init?.body)).completionIds); return Response.json({ marked: 1 }) }
        return page(rows)
    }))
    const h = await mount(false, ['a'], 's1')
    expect(writes).toEqual([['one']]); expect(h.value.items).toEqual([])
    visible = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    rows = [item('second')]
    await tick(); expect(writes).toHaveLength(1)
    visible = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(writes).toEqual([['one'], ['second']])
})

test('blur, a modal, inert chat and quitting defer automatic read until the conversation is readable', async () => {
    focus = false
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/read')) { writes.push(JSON.parse(String(init?.body)).completionIds); return Response.json({ marked: 1 }) }
        return page([item()])
    }))
    await mount(false, ['a'], 's1')
    expect(writes).toEqual([])
    const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); document.body.append(modal)
    focus = true
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(writes).toEqual([])
    const chat = document.createElement('section'); chat.setAttribute('aria-label', 'Coworker chat'); chat.setAttribute('inert', ''); document.body.append(chat)
    await act(async () => { modal.remove() })
    expect(writes).toEqual([])
    await act(async () => { await flushDesktopDrafts(); chat.removeAttribute('inert') })
    expect(writes).toEqual([])
    await act(async () => { cancelDraftShutdown() })
    expect(writes).toEqual([['one']])
})

test('automatic mark-read failure restores the item without a retry loop; only explicit Retry resends', async () => {
    let fail = true
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/read')) { writes.push(JSON.parse(String(init?.body)).completionIds); return Response.json({}, { status: fail ? 503 : 200 }) }
        return page([item()])
    }))
    const h = await mount(true, ['a'], 's1')
    expect(h.value.items).toHaveLength(1); expect(h.value.readError).toBe(true)
    await tick(); await tick()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(writes).toEqual([['one']])
    fail = false
    await act(async () => { h.value.retry() })
    expect(writes).toEqual([['one'], ['one']]); expect(h.value.items).toEqual([]); expect(h.value.readError).toBe(false)
})

test('failed manual read restores old IDs alongside a newer arrival without acknowledging it', async () => {
    let rows = [item()]
    let rejectRead!: (value: Response) => void
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/read')) { writes.push(JSON.parse(String(init?.body)).completionIds); return new Promise<Response>(resolve => { rejectRead = resolve }) }
        return page(rows)
    }))
    const h = await mount()
    await act(async () => { h.value.markRead(h.value.items[0]) })
    rows = [item('one', { completionIds: ['new', 'one'], count: 2, message: 'New result' })]
    await tick()
    expect(h.value.items[0].completionIds).toEqual(['new'])
    await act(async () => { rejectRead(Response.json({}, { status: 503 })) })
    expect(new Set(h.value.items[0].completionIds)).toEqual(new Set(['one', 'new']))
    expect(h.value.items[0].count).toBe(2); expect(writes).toEqual([['one']])
})

test('retained Mark all acknowledges its displayed IDs, not a newer poll in the same group', async () => {
    let rows = [item()]
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/read')) { writes.push(JSON.parse(String(init?.body)).completionIds); return Response.json({ marked: 1 }) }
        return page(rows)
    }))
    const h = await mount(); const markDisplayed = h.value.markAllRead
    rows = [item('one', { completionIds: ['one', 'new'], count: 2 })]
    await tick()
    await act(async () => { markDisplayed() })
    expect(writes).toEqual([['one']]); expect(h.value.items[0].completionIds).toEqual(['new'])
})

test('callbacks from a closed/reopened inbox, old owner scope or visible session cannot mutate', async () => {
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/read')) { writes.push(JSON.parse(String(init?.body)).completionIds); return Response.json({ marked: 1 }) }
        return page([item()])
    }))
    const h = await mount(); const old = h.value; const oldItem = old.items[0]
    await h.render(false); await h.render(true)
    await act(async () => { old.markRead(oldItem); old.markAllRead() })
    expect(writes).toEqual([])
    const reopened = h.value
    await h.render(true, ['b'], 's1')
    expect(h.value.items).toEqual([])
    await act(async () => { reopened.markRead(oldItem); reopened.markAllRead() })
    expect(writes).toEqual([])
    await h.render(true, ['a'], null)
    const beforeSession = h.value
    await h.render(true, ['a'], 'other-session')
    await act(async () => { beforeSession.markAllRead() })
    expect(writes).toEqual([])
})

test('mixed-session groups remain unread when only the newest conversation is visible', async () => {
    const fetcher = vi.fn(async () => page([item('schedule', { source: 'schedule', slug: 'job', sessionIds: ['s1', 's2'], completionIds: ['one', 'two'], count: 2 })]))
    vi.stubGlobal('fetch', fetcher)
    const h = await mount(false, ['a'], 's1')
    expect(h.value.items).toHaveLength(1)
    expect(fetcher.mock.calls).toHaveLength(1)
})

test('older-page failure retains usable rows and cursor for retry', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('?') ? fail ? Response.json({}, { status: 503 }) : page([item('older')]) : page([item()], 'older')))
    const h = await mount()
    await act(async () => { h.value.loadMore() })
    expect(h.value.status).toBe('failed'); expect(h.value.items).toHaveLength(1); expect(h.value.nextCursor).toBe('older')
    fail = false
    await act(async () => { h.value.loadMore() })
    expect(h.value.status).toBe('ready'); expect(h.value.items).toHaveLength(2)
})

test('a tile reads only its selected group after the exact conversation becomes visible', async () => {
    const group = item('schedule', { source: 'schedule', slug: 'nightly', sessionIds: ['s1', 's2'], completionIds: ['one', 'two'], count: 2 })
    let rows = [group, item('unrelated', { sessionId: 'other', sessionIds: ['other'] })]
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/read')) {
            writes.push(JSON.parse(String(init?.body)).completionIds)
            return Response.json({ marked: 2 })
        }
        return page(rows)
    }))
    const h = await mount()
    await act(async () => h.value.readResultWhenVisible(group))
    expect(writes).toEqual([])
    rows = [{ ...group, completionIds: ['new', 'one', 'two'], sessionIds: ['s-new', 's1', 's2'],
        sessionId: 's-new', completedAt: '2026-11-04T12:01:00.000Z', count: 3 }, rows[1]]
    await tick()
    await h.render(false, ['a'], 's1')
    expect(writes).toEqual([['one', 'two']])
    expect(h.value.items.flatMap(row => row.completionIds)).toEqual(['new', 'unrelated'])
})
