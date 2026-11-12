import type { Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const engine = vi.hoisted(() => ({
    createSchedule: vi.fn(), updateSchedule: vi.fn(), deleteSchedule: vi.fn(), listSchedules: vi.fn(), listRuns: vi.fn(), listLatestScheduleRuns: vi.fn(),
    getAgent: vi.fn(async () => ({ id: 'engine-owner' })),
}))
vi.mock('server-only', () => ({}))
vi.mock('../auth', async original => ({ ...await original<typeof import('../auth')>(), authenticateDesktopRequest: vi.fn(async () => ({})) }))
vi.mock('../settings', () => ({ engineOf: () => ({ baseUrl: 'http://127.0.0.1', apiKey: 'unused' }) }))
vi.mock('../store', () => ({ findDesktopAgent: vi.fn(async () => ({ id: 'local-owner', engineAgentId: 'engine-owner' })) }))
vi.mock('@/lib/engine/client', () => engine)
vi.mock('./adoption', () => ({ adoptDesktopScheduledSession: vi.fn() }))
import { desktopSchedulesApi, SCHEDULE_BODY_CLEANUP_MS, SCHEDULE_BODY_TIMEOUT_MS } from './api'
import { DesktopHttpError } from '../auth'
import { adoptDesktopScheduledSession } from './adoption'

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

test('adopts the exact latest routine result and distinguishes a new routine with no runs', async () => {
    const run = { id: 'saved', agentId: 'engine-owner', triggerSlug: 'daily', triggerSource: 'schedule', status: 'done', startedAt: '2026-01-01' }
    engine.listSchedules.mockResolvedValueOnce([{ ...valid.input, slug: 'daily' }, { ...valid.input, slug: 'new' }])
    engine.listLatestScheduleRuns.mockResolvedValueOnce([{ ...run, id: 'foreign', agentId: 'other' }, run])
    const chat = { agentId: 'local-owner', engineAgentId: 'engine-owner', sessionId: 'local-saved', engineSessionId: 'engine-saved',
        tabUid: 'schedule:local-saved', title: 'Daily', runId: 'saved' }
    vi.mocked(adoptDesktopScheduledSession).mockResolvedValueOnce(chat)
    const request = new Request('http://localhost/api/desktop/coworkers/local-owner/schedules')
    const response = await handle(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject([
        { slug: 'daily', lastResult: { status: 'done', runId: run.id, chat } }, { slug: 'new', lastResult: null },
    ])
    expect(engine.listRuns).not.toHaveBeenCalled()
    expect(engine.listLatestScheduleRuns).toHaveBeenCalledWith(expect.anything(), 'engine-owner', request.signal)
    expect(adoptDesktopScheduledSession).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), {
        agentId: 'local-owner', engineAgentId: 'engine-owner', scheduleSlug: 'daily', runId: 'saved',
    }, { signal: request.signal })
})

test('lists only the selected coworker’s scheduled runs and does not adopt while reading', async () => {
    const run = { id: 'daily-a', agentId: 'engine-owner', triggerSlug: 'daily', triggerSource: 'schedule', status: 'done', startedAt: '2026-11-01' }
    engine.listRuns.mockResolvedValueOnce([run, { ...run, agentId: 'foreign' }, { ...run, triggerSource: 'trigger' }, { ...run, triggerSlug: 'weekly' }])
    const request = new Request('http://localhost/schedules?history=daily')
    const response = await handle(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: run.id, status: run.status, startedAt: run.startedAt }])
    expect(engine.listRuns).toHaveBeenCalledWith(expect.anything(), 'engine-owner', { scheduleSlug: 'daily' }, { signal: request.signal })
    expect(adoptDesktopScheduledSession).not.toHaveBeenCalled()
})

test('discards history when the schedule grant is revoked during the engine read', async () => {
    engine.listRuns.mockImplementationOnce(async () => {
        authorize.mockRejectedValueOnce(new DesktopHttpError(403, 'Schedules disabled'))
        return []
    })
    const response = await handle(new Request('http://localhost/schedules?history=daily'))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Schedules disabled' })
})

test('opening a history row resolves the session from the exact run and schedule', async () => {
    vi.mocked(adoptDesktopScheduledSession).mockResolvedValueOnce({
        agentId: 'local-owner', engineAgentId: 'engine-owner', sessionId: 'local-session', engineSessionId: 'engine-session',
        tabUid: 'schedule:local-session', title: 'Daily', runId: 'older',
    })
    const request = new Request('http://localhost/schedules', {
        method: 'POST', body: JSON.stringify({ action: 'open-run', slug: 'daily', runId: 'older', engineSessionId: 'renderer-supplied' }),
    })
    const response = await handle(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sessionId: 'local-session', runId: 'older' })
    expect(adoptDesktopScheduledSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        agentId: 'local-owner', engineAgentId: 'engine-owner', runId: 'older', scheduleSlug: 'daily',
    }, { signal: request.signal, authorize: expect.any(Function) })
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


const exactModel = { connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' }

test('forwards a complete exact model selection on create', async () => {
    engine.createSchedule.mockResolvedValueOnce({ slug: 'task' })
    const response = await handle(new Request('http://localhost', {
        method: 'PUT', body: JSON.stringify({ input: { ...valid.input, ...exactModel } }),
    }))

    expect(response.status).toBe(200)
    expect(engine.createSchedule).toHaveBeenCalledWith(expect.anything(), 'engine-owner', expect.objectContaining(exactModel))
})

test('forwards a complete exact model selection on update', async () => {
    engine.updateSchedule.mockResolvedValueOnce({ slug: 'task' })
    const response = await handle(new Request('http://localhost', {
        method: 'PUT', body: JSON.stringify({ slug: 'task', input: { ...valid.input, ...exactModel } }),
    }))

    expect(response.status).toBe(200)
    expect(engine.updateSchedule).toHaveBeenCalledWith(expect.anything(), 'engine-owner', 'task', expect.objectContaining(exactModel))
})

test('omitted model fields preserve coworker-default semantics', async () => {
    engine.createSchedule.mockResolvedValueOnce({ slug: 'task' })
    const response = await handle(new Request('http://localhost', {
        method: 'PUT', body: JSON.stringify(valid),
    }))

    expect(response.status).toBe(200)
    expect(engine.createSchedule).toHaveBeenCalledWith(expect.anything(), 'engine-owner', expect.objectContaining({
        connectionId: null, provider: null, model: null,
    }))
})

test.each([
    { model: 'gpt-exact' },
    { connectionId: 'conn-b' },
    { provider: 'openai' },
    { connectionId: 'conn-b', model: 'gpt-exact' },
    { provider: 'openai', model: 'gpt-exact' },
    { connectionId: 'conn-b', provider: 'openai' },
])('rejects an incomplete model tuple without a mutation: %j', async fields => {
    const response = await handle(new Request('http://localhost', {
        method: 'PUT', body: JSON.stringify({ input: { ...valid.input, ...fields } }),
    }))

    expect(response.status).toBe(400)
    expect(engine.createSchedule).not.toHaveBeenCalled()
    expect(engine.updateSchedule).not.toHaveBeenCalled()
})
