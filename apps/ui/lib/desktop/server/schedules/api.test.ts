import type { Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const engine = vi.hoisted(() => ({
    createSchedule: vi.fn(), updateSchedule: vi.fn(), deleteSchedule: vi.fn(), listSchedules: vi.fn(), listRuns: vi.fn(),
    getAgent: vi.fn(async () => ({ id: 'engine-owner' })),
}))
vi.mock('server-only', () => ({}))
vi.mock('../auth', async original => ({ ...await original<typeof import('../auth')>(), authenticateDesktopRequest: vi.fn(async () => ({})) }))
vi.mock('../settings', () => ({ engineOf: () => ({ baseUrl: 'http://127.0.0.1', apiKey: 'unused' }) }))
vi.mock('../store', () => ({ findDesktopAgent: vi.fn(async () => ({ id: 'local-owner', engineAgentId: 'engine-owner' })) }))
vi.mock('@/lib/engine/client', () => engine)
vi.mock('./adoption', () => ({ adoptDesktopScheduledSession: vi.fn() }))
import { desktopSchedulesApi, SCHEDULE_BODY_CLEANUP_MS, SCHEDULE_BODY_TIMEOUT_MS } from './api'

const valid = { input: { name: 'Task', body: 'Read notes', description: '', cron: null, runAt: '2030-01-01T12:00:00Z', timezone: 'UTC', enabled: true } }
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const request = (signal: AbortSignal, read: () => Promise<ReadableStreamReadResult<Uint8Array>>, cancel: () => Promise<void>) => ({
    method: 'PUT', signal, body: { getReader: () => ({ read, cancel }) },
}) as unknown as Request
const authorize = vi.fn(async () => {})
const handle = (request: Request) => desktopSchedulesApi({} as Client, authorize)(request, 'local-owner')
async function enterBody(read: ReturnType<typeof vi.fn>) {
    for (let count = 0; count < 12 && !read.mock.calls.length; count++) await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

test.each([0, 99, 100])('distinguishes a new routine from a truncated run history of %i entries', async count => {
    engine.listSchedules.mockResolvedValueOnce([{ slug: 'task', ...valid.input }])
    engine.listRuns.mockResolvedValueOnce(Array.from({ length: count }, () => ({ triggerSource: 'chat', triggerSlug: null })))
    const response = await handle(new Request('http://localhost/api/desktop/coworkers/local-owner/schedules'))
    expect(response.status).toBe(200)
    expect((await response.json())[0]).toMatchObject({ lastResult: null, lastResultUnknown: count >= 100 })
})

test.each(['abort', 'deadline'] as const)('a stalled schedule body settles after %s even if cancellation never settles', async reason => {
    const stop = new AbortController(), late = deferred<ReadableStreamReadResult<Uint8Array>>()
    const read = vi.fn(() => late.promise), cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = handle(request(stop.signal, read, cancel))
    await enterBody(read)
    if (reason === 'abort') stop.abort()
    else await vi.advanceTimersByTimeAsync(SCHEDULE_BODY_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(SCHEDULE_BODY_CLEANUP_MS + 1)
    const result = await response
    expect(result.ok).toBe(false)
    if (reason === 'deadline') expect(result.status).toBe(408)
    expect(cancel).toHaveBeenCalled()
    late.resolve({ done: false, value: new TextEncoder().encode(JSON.stringify(valid)) })
    await Promise.resolve(); await Promise.resolve()
    expect(engine.createSchedule).not.toHaveBeenCalled()
    expect(engine.updateSchedule).not.toHaveBeenCalled()
    expect(engine.deleteSchedule).not.toHaveBeenCalled()
})

test('late read and cancellation rejection are observed without starting a schedule mutation', async () => {
    const stop = new AbortController(), late = deferred<ReadableStreamReadResult<Uint8Array>>()
    const read = vi.fn(() => late.promise), cancel = vi.fn(async () => { throw new Error('late cancel') })
    const response = handle(request(stop.signal, read, cancel))
    await enterBody(read)
    stop.abort()
    expect((await response).ok).toBe(false)
    late.reject(new Error('late read'))
    await Promise.resolve(); await Promise.resolve()
    expect(engine.createSchedule).not.toHaveBeenCalled()
})

test('cancellation after a mutation starts does not turn its successful result into a false refusal', async () => {
    const stop = new AbortController(), mutation = deferred<unknown>(), entered = deferred<void>()
    engine.createSchedule.mockImplementationOnce(() => { entered.resolve(); return mutation.promise })
    const read = vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(JSON.stringify(valid)) })
        .mockResolvedValueOnce({ done: true })
    const response = handle(request(stop.signal, read, vi.fn(async () => {})))
    await entered.promise
    stop.abort()
    mutation.resolve({ slug: 'task', ...valid.input })
    expect((await response).status).toBe(200)
    expect(engine.createSchedule).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledWith('engine-owner')
})
