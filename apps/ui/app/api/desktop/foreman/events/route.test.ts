import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopForemanChatRef, DesktopForemanLiveEvent } from '@rerun/contracts'

const binding = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('@/lib/desktop/server/http', () => ({ desktopRoute: (_request: Request, handler: (runtime: { workspaceId: number }) => Promise<Response>) => handler({ workspaceId: 7 }) }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => binding.current }))
import { GET } from './route'

const chat = { workspaceId: '7', chatId: 'fmc_00000000-0000-4000-8000-000000000001' }
const url = `http://127.0.0.1:3000/api/desktop/foreman/events?${new URLSearchParams(chat)}`
function app() {
    const lifetime = new AbortController(), cleanup = vi.fn()
    let emit: ((event: DesktopForemanLiveEvent) => void) | undefined
    const subscribe = vi.fn(async (_chat: DesktopForemanChatRef, _signal: AbortSignal, listener: (event: DesktopForemanLiveEvent) => void) => { emit = listener; return cleanup as () => void })
    return { voiceShutdownSignal: lifetime.signal, lifetime, subscribe, cleanup, emit: (event: DesktopForemanLiveEvent) => emit?.(event) }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers() })

it('closes an active keepalive stream and releases its subscriber on the exact binding shutdown, without waiting for browser abort', async () => {
    const original = app(), replacement = app(), request = new AbortController()
    binding.current = original
    const response = await GET(new Request(url, { signal: request.signal }))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': connected\n\n')
    expect(vi.getTimerCount()).toBe(1)
    binding.current = replacement; replacement.lifetime.abort()
    expect(original.cleanup).not.toHaveBeenCalled()
    const pending = reader.read()
    original.lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(request.signal.aborted).toBe(false)
    expect(original.cleanup).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
    expect(original.subscribe.mock.calls[0][1].aborted).toBe(true)
    expect(() => original.emit({ type: 'navigation', binding: { ...chat, runId: '00000000-0000-4000-8000-000000000002', model: { connectionId: 'c', model: 'm' } }, eventId: 'after-close', intent: { kind: 'open_box', spaceId: 'box' } })).not.toThrow()
    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBe(0)
})

it('shutdown during asynchronous ownership checks releases the late subscriber and never resurrects a keepalive', async () => {
    const current = app()
    let finish!: (cleanup: () => void) => void
    current.subscribe.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    binding.current = current
    const response = await GET(new Request(url)), reader = response.body!.getReader()
    current.lifetime.abort()
    finish(current.cleanup)
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    await Promise.resolve()
    expect(current.cleanup).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
})

it('browser cancellation remains idempotent and an already closed binding creates no subscription', async () => {
    const current = app(); binding.current = current
    const response = await GET(new Request(url)), reader = response.body!.getReader()
    await reader.read(); await reader.cancel()
    current.lifetime.abort()
    expect(current.cleanup).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
    const closed = app(); closed.lifetime.abort(); binding.current = closed
    const empty = await GET(new Request(url))
    expect(await empty.body!.getReader().read()).toEqual({ done: true, value: undefined })
    expect(closed.subscribe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})
