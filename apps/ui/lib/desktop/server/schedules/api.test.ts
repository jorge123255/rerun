import type { Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const engine = vi.hoisted(() => ({
    request: vi.fn(async (_engine: unknown, _path: string, _init: unknown, _parse: (value: unknown) => unknown): Promise<unknown> => { throw new Error('health unavailable') }),
    EngineRequestError: class EngineRequestError extends Error { constructor(message: string, readonly status: number) { super(message) } },
    createSchedule: vi.fn(), updateSchedule: vi.fn(), deleteSchedule: vi.fn(), listSchedules: vi.fn(), listRuns: vi.fn(), listLatestScheduleRuns: vi.fn(),
    getAgent: vi.fn(async () => ({ id: 'engine-owner', config: { setup: { required: false, completedAt: null as string | null } }, install: '' })),
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
import { ROUTINE_GUARD_MESSAGES } from '@rerun/contracts'

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

test('passes the reviewed deletion revision and abort signal to the owned engine schedule', async () => {
    const expectedRevision = 'a'.repeat(64)
    const request = new Request('http://localhost/schedules', {
        method: 'DELETE', body: JSON.stringify({ slug: 'daily', expectedRevision }),
    })
    const response = await handle(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deleted: 'daily' })
    expect(engine.deleteSchedule).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'engine-owner', 'daily', { expectedRevision, signal: request.signal })
})

test('keeps the reviewed Test Run request on its exact owner, routine and revision', async () => {
    const expectedRevision = 'a'.repeat(64)
    const requestId = '00000000-0000-4000-8000-000000000004'
    const saved = { agentId: 'local-owner', engineAgentId: 'engine-owner', sessionId: 'local-session', engineSessionId: 'engine-session',
        tabUid: 'schedule:local-session', title: 'Daily', runId: 'exact' }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ result: { run: { sessionId: saved.engineSessionId, runId: saved.runId } } }))
    vi.mocked(adoptDesktopScheduledSession).mockResolvedValueOnce(saved)
    try {
        const response = await handle(new Request('http://localhost/schedules', {
            method: 'POST', body: JSON.stringify({ action: 'run', slug: 'daily', requestId, expectedRevision }),
        }))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(saved)
        expect(fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1/desktop/workspace-routines/engine-owner', expect.objectContaining({
            method: 'POST', redirect: 'error',
            body: JSON.stringify({ operation: 'mutate', input: { action: 'run', agentId: 'local-owner', slug: 'daily', expectedRevision, requestId } }),
        }))
        expect(adoptDesktopScheduledSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
            agentId: 'local-owner', engineAgentId: 'engine-owner', engineSessionId: 'engine-session', runId: 'exact', scheduleSlug: 'daily',
        }, { signal: expect.any(AbortSignal), authorize: expect.any(Function) })
    } finally { fetch.mockRestore() }
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


// ---- Routine limits, checklist and quiet runs ----
const put = (body: unknown) => handle(new Request('http://localhost/schedules', { method: 'PUT', body: JSON.stringify(body) }))
const refusal = (message: string) => new engine.EngineRequestError(`rerun-engine POST /agents/engine-owner/schedules failed: 422 ${JSON.stringify({ error: message, code: 'routine_guard' })}`, 422)
const recurring = { ...valid.input, runAt: null, cron: '*/5 * * * *' }

test('refuses to create a routine that fires too often, with the plain message', async () => {
    vi.useRealTimers()
    engine.createSchedule.mockRejectedValueOnce(refusal(ROUTINE_GUARD_MESSAGES.interval))
    const response = await put({ input: recurring })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: ROUTINE_GUARD_MESSAGES.interval })
    expect(engine.createSchedule).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'engine-owner', expect.objectContaining({ cron: '*/5 * * * *' }))
})

test('refuses an edit to a faster schedule and enabling a twenty-first routine, with the plain message', async () => {
    vi.useRealTimers()
    engine.updateSchedule.mockRejectedValueOnce(refusal(ROUTINE_GUARD_MESSAGES.interval))
    const edited = await put({ slug: 'daily', input: recurring })
    expect(edited.status).toBe(422)
    expect(await edited.json()).toEqual({ error: ROUTINE_GUARD_MESSAGES.interval })
    engine.updateSchedule.mockRejectedValueOnce(refusal(ROUTINE_GUARD_MESSAGES.cap))
    const enabled = await put({ slug: 'daily', input: { ...valid.input, enabled: true } })
    expect(enabled.status).toBe(422)
    expect(await enabled.json()).toEqual({ error: ROUTINE_GUARD_MESSAGES.cap })
    engine.createSchedule.mockRejectedValueOnce(refusal(ROUTINE_GUARD_MESSAGES.cap))
    const created = await put(valid)
    expect(created.status).toBe(422)
    expect(await created.json()).toEqual({ error: ROUTINE_GUARD_MESSAGES.cap })
})

test('does not pass an unrelated engine failure through as a routine refusal', async () => {
    vi.useRealTimers()
    engine.createSchedule.mockRejectedValueOnce(new engine.EngineRequestError('rerun-engine POST failed: 422 {"error":"private diagnostic"}', 422))
    const response = await put(valid)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Schedule request failed' })
})

test('shows the last run’s checklist, a quiet run, limit warnings and an auto-off beside each routine', async () => {
    vi.useRealTimers()
    const run = (slug: string) => ({ id: `run-${slug}`, agentId: 'engine-owner', triggerSlug: slug, triggerSource: 'schedule', status: 'done', startedAt: '2026-01-01' })
    engine.listSchedules.mockResolvedValueOnce(['steps', 'quiet', 'stale', 'broken'].map(slug => ({ ...valid.input, slug, enabled: slug !== 'broken' })))
    engine.listLatestScheduleRuns.mockResolvedValueOnce(['steps', 'quiet', 'stale'].map(run))
    const checklist = { reported: true, parts: [
        { number: 1, text: 'Read', status: 'done', reason: null }, { number: 2, text: 'File', status: 'blocked', reason: 'the folder is locked' },
    ] }
    engine.request.mockImplementationOnce(async (_engine: unknown, path: string, _init: unknown, parse: (value: unknown) => unknown) => {
        expect(path).toBe('/desktop/workspace-routines/engine-owner/health')
        return parse({ limit: 20, enabledInWorkspace: 21, routines: [
            { slug: 'steps', warnings: ['interval', 'cap'], consecutiveFailures: 0, autoDisabledAt: null, lastOutcome: { runId: 'run-steps', quiet: false, test: false, checklist } },
            { slug: 'quiet', warnings: ['cap'], consecutiveFailures: 0, autoDisabledAt: null, lastOutcome: { runId: 'run-quiet', quiet: true, test: false, checklist: null } },
            { slug: 'stale', warnings: [], consecutiveFailures: 2, autoDisabledAt: null, lastOutcome: { runId: 'an-older-run', quiet: true, test: false, checklist: null } },
            { slug: 'broken', warnings: [], consecutiveFailures: 0, autoDisabledAt: '2026-11-10T08:00:00.000Z', lastOutcome: null },
        ] })
    })
    vi.mocked(adoptDesktopScheduledSession).mockResolvedValue(null as never)
    const rows = await (await handle(new Request('http://localhost/schedules'))).json() as Array<Record<string, unknown> & { lastResult: Record<string, unknown> | null }>
    expect(rows.map(row => row.slug)).toEqual(['steps', 'quiet', 'stale', 'broken'])
    expect(rows[0]).toMatchObject({ warnings: ['interval', 'cap'], autoDisabledAt: null, lastResult: { runId: 'run-steps', outcome: { quiet: false, test: false, checklist } } })
    expect(rows[1]).toMatchObject({ warnings: ['cap'], lastResult: { outcome: { quiet: true } } })
    // An outcome recorded for an older run is never shown against the latest one.
    expect(rows[2].lastResult).not.toHaveProperty('outcome')
    expect(rows[3]).toMatchObject({ enabled: false, autoDisabledAt: '2026-11-10T08:00:00.000Z', lastResult: null })
})

test('keeps the routine list when its health cannot be read', async () => {
    vi.useRealTimers()
    engine.listSchedules.mockResolvedValueOnce([{ ...valid.input, slug: 'daily' }])
    engine.listLatestScheduleRuns.mockResolvedValueOnce([])
    const response = await handle(new Request('http://localhost/schedules'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject([{ slug: 'daily', warnings: [], autoDisabledAt: null, lastResult: null }])
})
