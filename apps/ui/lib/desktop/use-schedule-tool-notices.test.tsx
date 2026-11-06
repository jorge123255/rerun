// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDesktopScheduleToolNotices } from './use-schedule-tool-notices'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const notice = { localAgentId: 'alice', slug: 'daily', operation: 'edit', outcome: 'committed', revision: 'new', at: '2026-11-05T00:00:00Z' }
let root: ReturnType<typeof createRoot>, host: HTMLDivElement
function Harness({ agentId, changed }: { agentId: string; changed: () => void }) { const last = useDesktopScheduleToolNotices(agentId, changed); return <span>{last?.slug}</span> }
beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('refreshes canonical routines once per new committed notice, including after remount', async () => {
    const changed = vi.fn(); let notices: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ notices })))
    await act(async () => root.render(<Harness agentId="alice" changed={changed} />)); expect(changed).not.toHaveBeenCalled()
    notices = [notice]
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) }); expect(changed).toHaveBeenCalledTimes(1); expect(host.textContent).toBe('daily')
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) }); expect(changed).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    await act(async () => root.render(<Harness agentId="alice" changed={changed} />)); expect(changed).toHaveBeenCalledTimes(2)
})
it('ignores delayed old-owner notices before dispatching the new owner refresh', async () => {
    let finish!: (response: Response) => void; const delayed = new Promise<Response>(resolve => { finish = resolve })
    const fetcher = vi.fn((url: string, _options: RequestInit) => url.includes('/alice/') ? delayed : Promise.resolve(Response.json({ notices: [] })))
    vi.stubGlobal('fetch', fetcher); const alice = vi.fn(), bob = vi.fn()
    await act(async () => root.render(<Harness agentId="alice" changed={alice} />))
    await act(async () => root.render(<Harness agentId="bob" changed={bob} />))
    await act(async () => { finish(Response.json({ notices: [notice] })) })
    expect(alice).not.toHaveBeenCalled(); expect(bob).not.toHaveBeenCalled(); expect(host.textContent).toBe('')
    expect(fetcher.mock.calls[0]![1].signal?.aborted).toBe(true)
})
