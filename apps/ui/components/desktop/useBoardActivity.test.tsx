// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useBoardActivity } from './useBoardActivity'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let result: ReturnType<typeof useBoardActivity>, container: HTMLDivElement, root: Root
const pending = { id: 'q', kind: 'question', agentId: 'alice', agentName: 'Alice', agentEnabled: true,
    sessionId: 'needs-answer', title: 'Choose version', summary: 'Which one?', updatedAt: '2026-11-04T11:00:00Z' }
const reply = (agents: Record<string, string>, items: object[] = []) => Response.json({ agents,
    attention: { items, unavailableAgentIds: [], checkedAt: '2026-11-04T12:00:00Z' } })
function Probe({ ids, enabled }: { ids: string[]; enabled?: boolean }) { result = useBoardActivity(ids, enabled); return null }
const render = (ids: string[], enabled?: boolean) => act(async () => { root.render(<Probe ids={ids} enabled={enabled} />) })
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

test('failed reads clear confirmed targets and mark every current coworker unavailable', async () => {
    let fail = false
    vi.stubGlobal('fetch', vi.fn(async () => fail ? Response.json({ error: 'offline' }, { status: 503 }) : reply({ alice: 'waiting_human', bob: 'idle' }, [pending])))
    await render(['alice', 'bob'])
    expect(result.attention.items).toHaveLength(1)
    fail = true
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(result.statuses).toEqual({ alice: 'unreachable', bob: 'unreachable' })
    expect(result.attention.items).toEqual([])
})

test('deleting a coworker aborts its old read and a late response cannot revive its target', async () => {
    let finish!: (response: Response) => void
    let firstSignal: AbortSignal | undefined
    let calls = 0
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (++calls === 1) {
            firstSignal = init?.signal as AbortSignal
            return new Promise<Response>(resolve => { finish = resolve })
        }
        return Promise.resolve(reply({ bob: 'working' }))
    })
    vi.stubGlobal('fetch', fetcher)
    await render(['alice', 'bob'])
    await render(['bob'])
    expect(firstSignal?.aborted).toBe(true)
    expect(result.statuses).toEqual({ bob: 'working' })
    await act(async () => { finish(reply({ alice: 'waiting_human', bob: 'idle' }, [pending])) })
    expect(result.statuses).toEqual({ bob: 'working' })
    expect(result.attention.items).toEqual([])
})

test('overlapping polls coalesce and an unchanged reordered roster retains its current snapshot', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    await render(['alice', 'bob'])
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { finish(reply({ alice: 'waiting_human', bob: 'idle' }, [pending])) })
    await render(['bob', 'alice'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.statuses).toEqual({ alice: 'waiting_human', bob: 'idle' })
    expect(result.attention.items[0].sessionId).toBe('needs-answer')
})

test('a disabled reader does not fetch on mount, polling, or refresh and enabling starts a read', async () => {
    const fetcher = vi.fn(async () => reply({ alice: 'working' }))
    vi.stubGlobal('fetch', fetcher)
    await render(['alice'], false)
    await act(async () => {
        expect(await result.refresh()).toBeNull()
        await vi.advanceTimersByTimeAsync(9000)
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.statuses).toEqual({})
    expect(result.attention.items).toEqual([])

    await render(['alice'], true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.statuses).toEqual({ alice: 'working' })
})

test('disabling aborts an in-flight read and neither a saved refresh nor its late result can restore it', async () => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal as AbortSignal
        return new Promise<Response>(resolve => { finish = resolve })
    })
    vi.stubGlobal('fetch', fetcher)
    await render(['alice'])
    const savedRefresh = result.refresh
    const pendingRefresh = savedRefresh()

    await render(['alice'], false)
    expect(signal?.aborted).toBe(true)
    await act(async () => {
        expect(await result.refresh()).toBeNull()
        expect(await savedRefresh()).toBeNull()
        await vi.advanceTimersByTimeAsync(6000)
        finish(reply({ alice: 'waiting_human' }, [pending]))
        expect(await pendingRefresh).toBeNull()
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.statuses).toEqual({})
    expect(result.attention.items).toEqual([])
})

test('explicit refresh shares an in-flight poll and returns the same normalized snapshot published by the hook', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    await render(['bob', 'alice', 'alice'])
    const refresh = result.refresh()
    expect(result.refresh()).toBe(refresh)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const normalized = {
        statuses: { alice: 'waiting_human', bob: 'unknown' },
        attention: { items: [pending], unavailableAgentIds: [], checkedAt: '2026-11-04T12:00:00Z' },
    }
    await act(async () => {
        finish(Response.json({
            agents: { alice: 'idle', outsider: 'working' },
            attention: {
                items: [pending, { ...pending, id: 'outside-q', agentId: 'outsider', sessionId: 'outside-chat' }],
                unavailableAgentIds: ['outsider'], checkedAt: '2026-11-04T12:00:00Z',
            },
        }))
        expect(await refresh).toEqual(normalized)
    })
    const refreshed = await refresh
    expect(result.statuses).toBe(refreshed?.statuses)
    expect(result.attention).toBe(refreshed?.attention)
    expect(fetcher).toHaveBeenCalledTimes(1)
})

test('a failed explicit refresh returns null, clears attention, and marks coworkers unreachable until recovery', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(reply({ alice: 'waiting_human', bob: 'idle' }, [pending]))
        .mockRejectedValueOnce(new Error('Network unavailable'))
        .mockResolvedValueOnce(reply({ alice: 'working', bob: 'idle' }))
    vi.stubGlobal('fetch', fetcher)
    await render(['alice', 'bob'])
    expect(result.attention.items).toEqual([pending])

    await act(async () => { expect(await result.refresh()).toBeNull() })
    expect(result.statuses).toEqual({ alice: 'unreachable', bob: 'unreachable' })
    expect(result.attention).toEqual({ items: [], unavailableAgentIds: [], checkedAt: '' })

    const recovered = {
        statuses: { alice: 'working', bob: 'idle' },
        attention: { items: [], unavailableAgentIds: [], checkedAt: '2026-11-04T12:00:00Z' },
    }
    await act(async () => { expect(await result.refresh()).toEqual(recovered) })
    expect(result.statuses).toEqual(recovered.statuses)
    expect(result.attention).toEqual(recovered.attention)
    expect(fetcher).toHaveBeenCalledTimes(3)
})
