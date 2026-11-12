import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-runs-'))
process.env.RERUN_API_KEY = ''

const sent = vi.hoisted(() => [] as { event?: string; kind: string; runId?: string | null; sessionId?: string | null; message: string; metadata?: Record<string, unknown> | null }[])

vi.mock('../../runtime/notify.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../runtime/notify.js')>()),
    sendNotification: async (payload: (typeof sent)[number]) => {
        sent.push(payload)
        return { delivered: true }
    },
}))

const afterRunRead = vi.hoisted(() => ({ finish: undefined as (() => Promise<void>) | undefined }))

vi.mock('../../db/repos/runs.js', async importOriginal => {
    const original = await importOriginal<typeof import('../../db/repos/runs.js')>()
    return { ...original, getRun: async (...args: Parameters<typeof original.getRun>) => {
        const row = await original.getRun(...args)
        const finish = afterRunRead.finish
        afterRunRead.finish = undefined
        await finish?.()
        return row
    } }
})

const { describe, expect, it, beforeAll, beforeEach } = await import('vitest')
const { mkdir } = await import('node:fs/promises')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir } = await import('../../config/paths.js')
const { createSession } = await import('../../db/repos/sessions.js')
const { failRun, finishRun, getRun, startRun } = await import('../../db/repos/runs.js')
const { appendMessage, listMessages } = await import('../../db/repos/messages.js')
const { reserveDesktopQueuedTurn } = await import('../../db/repos/desktop-queued-turns.js')
const { insertRunStep, insertToolCall } = await import('../../db/repos/telemetry.js')
const { getSystemDb } = await import('../../db/systemDb.js')
const { registerRunAbort, unregisterRunAbort, activeRunCount, claimSession, releaseSession, setRunCancel, sessionClaim } = await import('../../runtime/run-control.js')
const { registerRun } = await import('../../runtime/stream.js')
const { writeSchedule } = await import('../../schedules/loader.js')
const { registerSubRunStop } = await import('../../tools/builtin/sub-run-watch.js')

const id = 'runsagent'
const app = createServer()
const hour = 3600_000

type RunPatch = { status?: string; startedAt?: string; model?: string; totalTokens?: number; agentId?: string; triggerSource?: string; triggerSlug?: string; provider?: string }

async function seedRun(agentId: string, sessionId: string, patch: RunPatch = {}): Promise<string> {
    const run = await startRun(agentId, sessionId)
    const { client } = await getSystemDb(agentId)
    const columns: Record<string, unknown> = {
        status: patch.status,
        started_at: patch.startedAt,
        model: patch.model,
        total_tokens: patch.totalTokens,
        agent_id: patch.agentId,
        trigger_source: patch.triggerSource,
        trigger_slug: patch.triggerSlug,
        provider: patch.provider,
    }
    const set = Object.entries(columns).filter(([, value]) => value !== undefined)
    if (set.length > 0) await client.execute({ sql: `UPDATE runs SET ${set.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`, args: [...set.map(([, value]) => value as string | number), run.id] })
    return run.id
}

function api(path: string, init?: RequestInit) {
    return app.request(`/agents/${id}${path}`, init)
}

const cancel = (rid: string) => api(`/runs/${rid}/cancel`, { method: 'POST' })

let sessionId = ''

beforeAll(async () => {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'runs' }))
    sessionId = (await createSession(id, 'history')).id
})

beforeEach(() => {
    sent.length = 0
})

describe('GET /agents/:id/usage', () => {
    const usageAgent = 'usageagent'

    beforeAll(async () => {
        const session = await createSession(usageAgent)
        const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
        await seedRun(usageAgent, session.id, { status: 'done', startedAt: ago(hour), model: 'fresh', totalTokens: 1 })
        await seedRun(usageAgent, session.id, { status: 'done', startedAt: ago(3 * 24 * hour), model: 'week', totalTokens: 2 })
        await seedRun(usageAgent, session.id, { status: 'done', startedAt: ago(20 * 24 * hour), model: 'month', totalTokens: 4 })
        await seedRun(usageAgent, session.id, { status: 'done', startedAt: ago(400 * 24 * hour), model: 'ancient', totalTokens: 8 })
        await seedRun(usageAgent, session.id, { status: 'error', startedAt: ago(hour), model: 'failed', totalTokens: 16 })
    })

    async function modelsIn(range?: string): Promise<string[]> {
        const res = await app.request(`/agents/${usageAgent}/usage${range === undefined ? '' : `?range=${range}`}`)
        expect(res.status).toBe(200)
        const { buckets } = (await res.json()) as { buckets: { model: string }[] }
        return buckets.map(b => b.model).sort()
    }

    it('covers the last 7 days by default', async () => {
        expect(await modelsIn()).toEqual(['fresh', 'week'])
    })

    it('narrows and widens with the range', async () => {
        expect(await modelsIn('24h')).toEqual(['fresh'])
        expect(await modelsIn('30d')).toEqual(['fresh', 'month', 'week'])
        expect(await modelsIn('all')).toEqual(['ancient', 'fresh', 'month', 'week'])
    })

    it('falls back to 7 days on a range it does not know', async () => {
        expect(await modelsIn('90d')).toEqual(['fresh', 'week'])
    })

    it('sums the tokens of the finished runs only', async () => {
        const res = await app.request(`/agents/${usageAgent}/usage?range=24h`)
        const { buckets } = (await res.json()) as { buckets: { totalTokens: number; runCount: number }[] }
        expect(buckets).toEqual([expect.objectContaining({ totalTokens: 1, runCount: 1 })])
    })
})

describe('GET /agents/:id/runs', () => {
    const listAgent = 'listagent'

    beforeAll(async () => {
        const session = await createSession(listAgent)
        const { client } = await getSystemDb(listAgent)
        const base = Date.parse('2026-01-01T00:00:00.000Z')
        await client.batch(
            Array.from({ length: 205 }, (_, i) => ({
                sql: 'INSERT INTO runs (id, agent_id, session_id, status, started_at) VALUES (?, ?, ?, ?, ?)',
                args: [`run-${String(i).padStart(3, '0')}`, listAgent, session.id, 'done', new Date(base + i * 1000).toISOString()],
            })),
        )
    })

    async function listed(query = ''): Promise<string[]> {
        const res = await app.request(`/agents/${listAgent}/runs${query}`)
        expect(res.status).toBe(200)
        return ((await res.json()) as { runs: { id: string }[] }).runs.map(r => r.id)
    }

    it('returns the 50 most recent runs first by default', async () => {
        const ids = await listed()
        expect(ids).toHaveLength(50)
        expect(ids[0]).toBe('run-204')
    })

    it('honours a limit and caps it at 200', async () => {
        expect(await listed('?limit=3')).toEqual(['run-204', 'run-203', 'run-202'])
        expect(await listed('?limit=1000')).toHaveLength(200)
    })

    it('ignores a limit that is not a positive number', async () => {
        expect(await listed('?limit=0')).toHaveLength(50)
        expect(await listed('?limit=-4')).toHaveLength(50)
        expect(await listed('?limit=lots')).toHaveLength(50)
    })

    it('finds a session run that fell out of the most recent 200', async () => {
        const { client } = await getSystemDb(listAgent)
        await client.execute({
            sql: 'INSERT INTO runs (id, agent_id, session_id, status, started_at) VALUES (?, ?, ?, ?, ?)',
            args: ['buried', listAgent, 'buried-session', 'running', '2025-01-01T00:00:00.000Z'],
        })

        expect(await listed('?limit=200')).not.toContain('buried')
        expect(await listed('?session=buried-session')).toEqual(['buried'])
        expect(await listed('?session=buried-session&status=done')).toEqual([])
        expect(await listed('?status=running')).toEqual(['buried'])
    })

    it('filters scheduled runs by owner and slug before applying the limit', async () => {
        const { client } = await getSystemDb(listAgent)
        await client.batch([
            ['daily-older', listAgent, 'schedule', 'daily', '2024-01-01'],
            ['daily-newer', listAgent, 'schedule', 'daily', '2024-01-02'],
            ['weekly', listAgent, 'schedule', 'weekly', '2024-01-03'],
            ['webhook', listAgent, 'trigger', 'daily', '2024-01-04'],
            ['foreign', 'other-agent', 'schedule', 'daily', '2024-01-05'],
        ].map(args => ({
            sql: "INSERT INTO runs (id, agent_id, trigger_source, trigger_slug, started_at, session_id, status) VALUES (?, ?, ?, ?, ?, 'fixture-session', 'done')",
            args,
        })))
        expect(await listed('?schedule=daily&limit=2')).toEqual(['daily-newer', 'daily-older'])
        expect(await listed('?schedule=weekly')).toEqual(['weekly'])
        expect((await app.request(`/agents/${listAgent}/runs?schedule=..`)).status).toBe(400)
    })

    it('returns the latest and active runs for configured schedules despite newer unrelated chats', async () => {
        for (const name of ['Daily', 'Weekly', 'Never run']) {
            await writeSchedule(listAgent, { name, body: 'Fixture', cron: '0 8 * * *', enabled: false })
        }
        const { client } = await getSystemDb(listAgent)
        await client.batch([
            ['daily-active', listAgent, 'schedule', 'daily', '2024-01-01', 'running'],
            ['daily-tied-z', listAgent, 'schedule', 'daily', '2024-01-03', 'done'],
            ['daily-tied-a', listAgent, 'schedule', 'daily', '2024-01-03', 'error'],
            ['weekly-active', listAgent, 'schedule', 'weekly', '2024-01-04', 'running'],
            ['removed', listAgent, 'schedule', 'removed', '2024-01-05', 'done'],
            ['foreign-active', 'other-agent', 'schedule', 'daily', '2024-01-06', 'running'],
        ].map(args => ({
            sql: "INSERT INTO runs (id, agent_id, trigger_source, trigger_slug, started_at, status, session_id) VALUES (?, ?, ?, ?, ?, ?, 'fixture-session')",
            args,
        })))
        expect(await listed('?limit=100')).not.toContain('daily-tied-z')
        const response = await app.request(`/agents/${listAgent}/runs/latest-scheduled`)
        expect(response.status).toBe(200)
        const { runs } = await response.json() as { runs: Array<{ id: string; status: string }> }
        expect(runs.map(({ id, status }) => [id, status])).toEqual([
            ['weekly-active', 'running'], ['daily-tied-z', 'done'], ['daily-active', 'running'],
        ])
    })
})

describe('GET /agents/:id/runs/:rid', () => {
    it('404s on an unknown run', async () => {
        const res = await api('/runs/nope')
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'run not found' })
    })

    it('404s on a run filed under another agent', async () => {
        const rid = await seedRun(id, sessionId, { agentId: 'someone-else' })
        expect((await api(`/runs/${rid}`)).status).toBe(404)
        expect((await api(`/runs/${rid}/steps`)).status).toBe(404)
        expect((await api(`/runs/${rid}/tools`)).status).toBe(404)
        expect((await cancel(rid)).status).toBe(404)
        expect((await api(`/runs/${rid}/stream`)).status).toBe(204)
    })

    it('returns the run with what the assistant said during it', async () => {
        const session = await createSession(id, 'with output')
        const rid = await seedRun(id, session.id, { startedAt: '2000-01-01T00:00:00.000Z' })
        await appendMessage(id, session.id, { role: 'user', content: 'question' })
        await appendMessage(id, session.id, { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] })
        const res = await api(`/runs/${rid}`)
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ id: rid, sessionId: session.id, output: 'the answer' })
    })

    it('lists the steps and tool calls of a run', async () => {
        const rid = await seedRun(id, sessionId)
        const createdAt = new Date().toISOString()
        await insertRunStep(id, { id: 'step-2', runId: rid, agentId: id, sessionId, stepNumber: 2, provider: null, model: null, finishReason: 'stop', inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null, toolCallCount: 0, textLength: 0, durationMs: null, createdAt })
        await insertRunStep(id, { id: 'step-1', runId: rid, agentId: id, sessionId, stepNumber: 1, provider: null, model: null, finishReason: 'tool-calls', inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null, toolCallCount: 1, textLength: 0, durationMs: null, createdAt })
        await insertToolCall(id, { id: 'call-1', runId: rid, agentId: id, sessionId, stepNumber: 1, toolCallId: 'c1', toolName: 'web_fetch', inputJson: null, resultJson: null, isError: 0, durationMs: 5, createdAt })

        const steps = (await (await api(`/runs/${rid}/steps`)).json()) as { steps: { id: string }[] }
        expect(steps.steps.map(s => s.id)).toEqual(['step-1', 'step-2'])
        const tools = (await (await api(`/runs/${rid}/tools`)).json()) as { tools: { toolName: string }[] }
        expect(tools.tools.map(t => t.toolName)).toEqual(['web_fetch'])
    })
})

describe('GET /agents/:id/runs/:rid/stream', () => {
    it('answers 204 for a run it does not know', async () => {
        expect((await api('/runs/nope/stream')).status).toBe(204)
    })

    it('answers 204 for a known run with no live stream', async () => {
        const rid = await seedRun(id, sessionId, { status: 'done' })
        expect((await api(`/runs/${rid}/stream`)).status).toBe(204)
    })

    it('replays a live run as an event stream', async () => {
        const rid = await seedRun(id, sessionId)
        registerRun(rid, async writer => {
            writer.write({ type: 'text-start', id: 't' })
            writer.write({ type: 'text-delta', id: 't', delta: 'replayed words' })
            writer.write({ type: 'text-end', id: 't' })
        })
        const res = await api(`/runs/${rid}/stream`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('text/event-stream')
        expect(await res.text()).toContain('replayed words')
    })
})

describe('POST /agents/:id/runs/:rid/cancel', () => {
    it('404s on an unknown run', async () => {
        expect((await cancel('nope')).status).toBe(404)
    })

    it('aborts a live run and lets its loop announce the end', async () => {
        const rid = await seedRun(id, sessionId)
        const controller = registerRunAbort(rid)
        const res = await cancel(rid)
        expect(await res.json()).toEqual({ ok: true, aborted: true })
        expect(controller.signal.aborted).toBe(true)
        expect(activeRunCount()).toBe(0)
        expect((await getRun(id, rid))?.status).toBe('cancelled')
        expect(sent).toEqual([])
    })

    it('desktop Stop waits for the prior transcript and teardown before a queued turn can claim the session', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const session = await createSession(id, 'queued after Stop')
        const rid = await seedRun(id, session.id)
        const nextId = crypto.randomUUID()
        let allowPersistence!: () => void, allowTeardown!: () => void, entered!: () => void, persisted!: () => void
        const persistence = new Promise<void>(resolve => { allowPersistence = resolve })
        const teardown = new Promise<void>(resolve => { allowTeardown = resolve })
        const cancelling = new Promise<void>(resolve => { entered = resolve })
        const saved = new Promise<void>(resolve => { persisted = resolve })
        registerRunAbort(rid)
        claimSession(session.id, rid)
        setRunCancel(rid, async () => {
            entered()
            await persistence
            await appendMessage(id, session.id, { role: 'assistant', content: 'Previous final reply' })
            persisted()
            await teardown
            unregisterRunAbort(rid)
        })
        let finished = false
        const stopping = cancel(rid).then(response => { finished = true; return response })
        try {
            await cancelling
            expect(finished).toBe(false)
            expect(claimSession(session.id, nextId)).toBe(rid)
            expect(await listMessages(id, session.id)).toHaveLength(0)
            allowPersistence()
            await saved
            expect(finished).toBe(false)
            expect(claimSession(session.id, nextId)).toBe(rid)
            allowTeardown()
            expect((await stopping).status).toBe(200)
            expect(sessionClaim(session.id)).toBeNull()
            expect(claimSession(session.id, nextId)).toBeNull()
            await reserveDesktopQueuedTurn(id, { runId: nextId, sessionId: session.id, message: 'Follow-up after Stop' })
            const messages = await listMessages(id, session.id)
            expect(messages.map(message => message.role)).toEqual(['assistant', 'user'])
            expect(messages[0].contentJson).toContain('Previous final reply')
            expect(messages[1].contentJson).toContain('Follow-up after Stop')
        } finally {
            allowPersistence()
            allowTeardown()
            await stopping
            unregisterRunAbort(rid)
            releaseSession(nextId)
            vi.unstubAllEnvs()
        }
    })

    it('a failed desktop cancellation reports an error and a later Stop can close the orphan', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const session = await createSession(id, 'failed Stop')
        const rid = await seedRun(id, session.id)
        registerRunAbort(rid)
        claimSession(session.id, rid)
        setRunCancel(rid, async () => { throw new Error('failed persistence') })
        try {
            expect((await cancel(rid)).status).toBe(503)
            expect(sessionClaim(session.id)).toBeNull()
            expect((await cancel(rid)).status).toBe(200)
            expect((await getRun(id, rid))?.status).toBe('cancelled')
        } finally { unregisterRunAbort(rid); vi.unstubAllEnvs() }
    })

    it('closes an orphaned run and tells the hub itself', async () => {
        const rid = await seedRun(id, sessionId, { triggerSource: 'schedule', triggerSlug: 'daily-digest', provider: 'anthropic', model: 'claude-sonnet-4-6' })
        const res = await cancel(rid)
        expect(await res.json()).toEqual({ ok: true, aborted: false })
        expect((await getRun(id, rid))?.status).toBe('cancelled')
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({
            event: 'agent.schedule.completed',
            kind: 'done',
            runId: rid,
            sessionId,
            message: 'Schedule "daily-digest" stopped',
            metadata: expect.objectContaining({ status: 'cancelled', scheduleSlug: 'daily-digest', provider: 'anthropic', model: 'claude-sonnet-4-6' }),
        })
    })

    it.each(['done', 'error'] as const)('keeps a %s terminal when Stop loses the race', async status => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const rid = await seedRun(id, sessionId)
        afterRunRead.finish = () => status === 'done' ? finishRun(id, rid, null, 1) : failRun(id, rid, 'failed before Stop')
        try {
            expect((await cancel(rid)).status).toBe(409)
            expect((await getRun(id, rid))?.status).toBe(status)
            expect(sent).toEqual([])
        } finally {
            afterRunRead.finish = undefined
            vi.unstubAllEnvs()
        }
    })

    it('only the Stop that changes an orphaned run announces cancellation', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const rid = await seedRun(id, sessionId)
        try {
            const responses = await Promise.all([cancel(rid), cancel(rid)])
            expect(responses.map(response => response.status).sort()).toEqual([200, 409])
            expect((await getRun(id, rid))?.status).toBe('cancelled')
            expect(sent).toHaveLength(1)
        } finally { vi.unstubAllEnvs() }
    })

    it('leaves a finished run as it was', async () => {
        const rid = await seedRun(id, sessionId, { status: 'done' })
        const res = await cancel(rid)
        expect(await res.json()).toEqual({ ok: true, aborted: false })
        expect((await getRun(id, rid))?.status).toBe('done')
        expect(sent).toEqual([])
    })

    it('still aborts a live loop whose row is already settled', async () => {
        const rid = await seedRun(id, sessionId, { status: 'error' })
        registerRunAbort(rid)
        expect(await (await cancel(rid)).json()).toEqual({ ok: true, aborted: true })
        expect((await getRun(id, rid))?.status).toBe('error')
        unregisterRunAbort(rid)
    })
})

describe('POST /agents/:id/runs/:rid/tasks/:taskId/cancel', () => {
    it('404s on an unknown run', async () => {
        expect((await api('/runs/nope/tasks/t1/cancel', { method: 'POST' })).status).toBe(404)
    })

    it('stops a running sub-agent once', async () => {
        const rid = await seedRun(id, sessionId)
        const signal = registerSubRunStop('task-1')
        expect(await (await api(`/runs/${rid}/tasks/task-1/cancel`, { method: 'POST' })).json()).toEqual({ ok: true, aborted: true })
        expect(signal.aborted).toBe(true)
        expect(await (await api(`/runs/${rid}/tasks/task-1/cancel`, { method: 'POST' })).json()).toEqual({ ok: true, aborted: false })
    })
})
