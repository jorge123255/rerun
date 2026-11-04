import { afterEach, expect, test, vi } from 'vitest'
import { DesktopRecentCoworkersController } from './recent-coworkers'
import type { DesktopRecentCoworkers, DesktopRecentCoworkerVisit } from './recent-coworkers.schema'

const stores: DesktopRecentCoworkersController[] = []
function store(initial: DesktopRecentCoworkers = { revision: 0, recentAgentIds: [] }) {
    const result = new DesktopRecentCoworkersController(initial)
    stores.push(result)
    result.setRoster(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    result.observeSelection(null)
    return result
}
function deferred() {
    let resolve!: (response: Response) => void
    let reject!: (error: Error) => void
    const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const body = (options?: RequestInit) => JSON.parse(String(options?.body)) as DesktopRecentCoworkerVisit
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
afterEach(() => { for (const item of stores.splice(0)) item.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

test('bootstrap and restored observations never write; actual visits keep five unique IDs in original MRU order', async () => {
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
        const payload = body(options)
        ids = [payload.agentId, ...ids.filter(id => id !== payload.agentId)].slice(0, 5)
        return Response.json({ revision: ++revision, recentAgentIds: ids })
    })
    let revision = 8, ids = ['c', 'b']
    vi.stubGlobal('fetch', fetcher)
    const restored = new DesktopRecentCoworkersController({ revision, recentAgentIds: ids }); stores.push(restored)
    restored.observeSelection('c')
    restored.observeSelection('c')
    expect(fetcher).not.toHaveBeenCalled()
    for (const id of ['a', 'b', 'd', 'e', 'f', 'b', 'g']) restored.observeSelection(id)
    expect(restored.getSnapshot().recentAgentIds).toEqual(['g', 'b', 'f', 'e', 'd'])
    await restored.flush()
    expect(ids).toEqual(['g', 'b', 'f', 'e', 'd'])
    expect(fetcher.mock.calls.every(([, options]) => options?.keepalive === true)).toBe(true)
})

test('serializes rapid visits and overlays later choices while the first acknowledgment is delayed', async () => {
    const first = deferred(), second = deferred()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    recent.observeSelection('a')
    recent.observeSelection('b')
    await tick()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(recent.getSnapshot().recentAgentIds).toEqual(['b', 'a'])
    first.resolve(Response.json({ revision: 1, recentAgentIds: ['a'] }))
    await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(body(fetcher.mock.calls[1][1])).toMatchObject({ agentId: 'b', baseRevision: 1 })
    expect(recent.getSnapshot().recentAgentIds).toEqual(['b', 'a'])
    second.resolve(Response.json({ revision: 2, recentAgentIds: ['b', 'a'] }))
    await recent.flush()
    expect(recent.getSnapshot()).toEqual({ recentAgentIds: ['b', 'a'], saving: false })
})

test('failed saves wait for explicit Retry and reuse the exact uncertain payload', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Lost ACK')).mockResolvedValueOnce(Response.json({ revision: 1, recentAgentIds: ['a'] }))
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    recent.observeSelection('a')
    await tick()
    expect(recent.getSnapshot().error).toContain('Could not save')
    await recent.flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    recent.retry()
    await recent.flush()
    expect(body(fetcher.mock.calls[1][1])).toEqual(body(fetcher.mock.calls[0][1]))
    expect(recent.getSnapshot().error).toBeUndefined()
})

test('lost ACK followed by another writer never re-promotes the superseded visit on 409', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Accepted A, lost ACK'))
        .mockResolvedValueOnce(Response.json({ error: 'Conflict', recent: { revision: 2, recentAgentIds: ['b', 'a'] } }, { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    recent.observeSelection('a')
    await tick()
    recent.retry()
    await recent.flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(body(fetcher.mock.calls[1][1])).toEqual(body(fetcher.mock.calls[0][1]))
    expect(recent.getSnapshot()).toEqual({ recentAgentIds: ['b', 'a'], saving: false })
})

test('conflict adopts the server list then sends only genuinely later local visits with its revision', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ error: 'Conflict', recent: { revision: 10, recentAgentIds: ['c'] } }, { status: 409 }))
        .mockResolvedValueOnce(Response.json({ revision: 11, recentAgentIds: ['b', 'c'] }))
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    recent.observeSelection('a')
    recent.observeSelection('b')
    await recent.flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    const first = body(fetcher.mock.calls[0][1]), second = body(fetcher.mock.calls[1][1])
    expect(second).toMatchObject({ agentId: 'b', baseRevision: 10 })
    expect(second.requestId).not.toBe(first.requestId)
    expect(recent.getSnapshot().recentAgentIds).toEqual(['b', 'c'])
})

test('404 drops obsolete visits while pending deletion 503 remains retryable', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Missing' }, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ error: 'Deletion pending' }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ revision: 1, recentAgentIds: ['b'] }))
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    recent.observeSelection('a'); recent.observeSelection('b'); recent.observeSelection('a')
    await recent.flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(recent.getSnapshot()).toMatchObject({ recentAgentIds: ['b'], error: expect.any(String) })
    recent.retry()
    await recent.flush()
    expect(body(fetcher.mock.calls[2][1])).toEqual(body(fetcher.mock.calls[1][1]))
    expect(recent.getSnapshot()).toEqual({ recentAgentIds: ['b'], saving: false })
})

test('roster deletion prunes a pending visit without displacing the fifth live saved coworker', async () => {
    const pending = deferred()
    vi.stubGlobal('fetch', vi.fn(() => pending.promise))
    const recent = store({ revision: 5, recentAgentIds: ['a', 'b', 'c', 'd', 'e'] })
    recent.observeSelection('f')
    await tick()
    recent.setRoster(['a', 'b', 'c', 'd', 'e'])
    expect(recent.getSnapshot().recentAgentIds).toEqual(['a', 'b', 'c', 'd', 'e'])
    pending.resolve(Response.json({ error: 'Missing' }, { status: 404 }))
    await recent.flush()
    expect(recent.getSnapshot().error).toBeUndefined()
})

test('a visit queued at the acknowledgment boundary automatically starts its own save', async () => {
    let revision = 0
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => Response.json({ revision: ++revision, recentAgentIds: body(options).agentId === 'a' ? ['a'] : ['b', 'a'] }))
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    let queued = false
    recent.subscribe(() => {
        if (!queued && !recent.getSnapshot().saving && recent.getSnapshot().recentAgentIds[0] === 'a') {
            queued = true
            queueMicrotask(() => recent.observeSelection('b'))
        }
    })
    recent.observeSelection('a')
    await tick(); await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(recent.getSnapshot()).toEqual({ recentAgentIds: ['b', 'a'], saving: false })
})

test('quit flush is bounded, ignores late aborted acknowledgment and leaves an exact manual retry', async () => {
    vi.useFakeTimers()
    const pending = deferred()
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json({ revision: 1, recentAgentIds: ['a'] }))
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    recent.observeSelection('a')
    const flushed = recent.flush()
    await vi.advanceTimersByTimeAsync(1_500)
    await flushed
    expect(recent.getSnapshot().error).toContain('Could not save')
    pending.resolve(Response.json({ revision: 1, recentAgentIds: ['a'] }))
    await vi.advanceTimersByTimeAsync(6_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(recent.getSnapshot().error).toContain('Could not save')
    recent.retry()
    await recent.flush()
    expect(body(fetcher.mock.calls[1][1])).toEqual(body(fetcher.mock.calls[0][1]))
})

test('quit blocks new visits and a cancelled quit permits the still-current visit afterward', async () => {
    const drafts = await import('./draft-writes')
    const quitting = vi.spyOn(drafts, 'isDesktopQuitting').mockReturnValue(false)
    const fetcher = vi.fn(async () => Response.json({ revision: 1, recentAgentIds: ['a'] }))
    vi.stubGlobal('fetch', fetcher)
    const recent = store()
    quitting.mockReturnValue(true)
    recent.observeSelection('a')
    expect(fetcher).not.toHaveBeenCalled()
    quitting.mockReturnValue(false)
    recent.observeSelection('a')
    await recent.flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
})
