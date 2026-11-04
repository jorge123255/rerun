import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-stats-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it, beforeAll, vi } = await import('vitest')
const { createServer } = await import('../server.js')
const { getSystemDb } = await import('../../db/systemDb.js')
const { createSession } = await import('../../db/repos/sessions.js')
const { agentDir, configPath } = await import('../../config/paths.js')

const id = 'statsagent'
const app = createServer()
const hour = 3600_000

type Point = { bucket: string; group: string | null; value: number; count: number }

const recent = new Date(Date.now() - 2 * hour).toISOString()
const lastWeek = new Date(Date.now() - 3 * 24 * hour).toISOString()
const longAgo = new Date(Date.now() - 200 * 24 * hour).toISOString()

async function stats(query: string) {
    return app.request(`/agents/${id}/stats?${query}`)
}

async function points(query: string): Promise<Point[]> {
    const res = await stats(query)
    expect(res.status).toBe(200)
    return ((await res.json()) as { points: Point[] }).points
}

const total = (list: Point[]) => list.reduce((sum, p) => sum + p.value, 0)

beforeAll(async () => {
    const session = await createSession(id, 'stats')
    const { client } = await getSystemDb(id)
    const rows: [string, string, string, string][] = [
        ['r1', 'done', recent, 'model-a'],
        ['r2', 'error', recent, 'model-b'],
        ['r3', 'done', lastWeek, 'model-a'],
        ['r4', 'done', longAgo, 'model-a'],
    ]
    for (const [runId, status, startedAt, model] of rows) {
        await client.execute({ sql: 'INSERT INTO runs (id, agent_id, session_id, status, started_at, model) VALUES (?, ?, ?, ?, ?, ?)', args: [runId, id, session.id, status, startedAt, model] })
    }
})

describe('GET /agents/:id/stats', () => {
    it('returns an empty desktop window for an unused coworker and never creates a missing coworker', async () => {
        const unused = 'unused-owner'
        const missing = 'absent-owner'
        mkdirSync(agentDir(unused), { recursive: true })
        writeFileSync(configPath(unused), JSON.stringify({ name: unused }))
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const route = (owner: string) => app.request(`/agents/${owner}/stats?dataset=runs&metric=count`)
            const empty = await route(unused)
            expect(empty.status).toBe(200)
            expect(await empty.json()).toEqual({ points: [] })
            expect((await route(missing)).status).toBe(404)
            expect(existsSync(agentDir(missing))).toBe(false)
        } finally {
            vi.unstubAllEnvs()
        }
    })

    it('returns every tool group in a bounded desktop chart while generic queries keep their cap', async () => {
        const owner = 'busy-tool-owner'
        mkdirSync(agentDir(owner), { recursive: true })
        writeFileSync(configPath(owner), JSON.stringify({ name: owner }))
        const { client } = await getSystemDb(owner)
        await client.executeMultiple(`
            WITH RECURSIVE days(d) AS (SELECT 1 UNION ALL SELECT d + 1 FROM days WHERE d < 84),
                tools(t) AS (SELECT 1 UNION ALL SELECT t + 1 FROM tools WHERE t < 60)
            INSERT INTO tool_calls (id, agent_id, run_id, session_id, step_number, tool_name, is_error, created_at)
            SELECT printf('%d.%d', d, t), 'busy-tool-owner', 'run', 'session', 1, printf('tool-%d', t), t = 60,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d days', d))
            FROM days CROSS JOIN tools;
            INSERT INTO tool_calls (id, agent_id, run_id, session_id, step_number, tool_name, is_error, created_at)
            VALUES ('future', 'busy-tool-owner', 'run', 'session', 1, 'future', 1, '9999-01-01T00:00:00.000Z');
        `)
        async function chart(metric: 'count' | 'errorCount', range = '90d'): Promise<Point[]> {
            const result = await app.request(`/agents/${owner}/stats?dataset=toolCalls&groupBy=toolName&metric=${metric}&range=${range}`)
            expect(result.status).toBe(200)
            return (await result.json()).points
        }
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const calls = await chart('count')
            expect(calls).toHaveLength(84 * 60)
            expect(total(calls)).toBe(84 * 60)
            expect(calls.some(point => point.group === 'future')).toBe(false)
            const errors = await chart('errorCount')
            expect(errors).toHaveLength(84 * 60)
            expect(total(errors)).toBe(84)
            expect(await chart('count', 'all')).toHaveLength(5000)
            vi.stubEnv('RERUN_DESKTOP_APP', '0')
            expect(await chart('count')).toHaveLength(5000)
        } finally {
            vi.unstubAllEnvs()
        }
    })

    it.each([
        ['no dataset', 'metric=count'],
        ['an unknown dataset', 'dataset=widgets&metric=count'],
        ['a metric the dataset does not have', 'dataset=sessions&metric=cost'],
        ['a coverage metric outside the runs dataset', 'dataset=toolCalls&metric=recordedTokenRuns'],
        ['a cost coverage metric outside the runs dataset', 'dataset=sessions&metric=recordedCostRuns'],
        ['a grouping the dataset does not have', 'dataset=toolCalls&metric=count&groupBy=model'],
        ['an unknown range', 'dataset=runs&metric=count&range=1y'],
    ])('refuses %s', async (_, query) => {
        const res = await stats(query)
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'invalid stats query' })
    })

    it('buckets the last 24 hours by hour', async () => {
        const list = await points('dataset=runs&metric=count&range=24h')
        expect(list).toEqual([{ bucket: `${recent.slice(0, 13)}:00`, group: null, value: 2, count: 2 }])
    })

    it('buckets longer ranges by day and defaults to 7 days', async () => {
        const list = await points('dataset=runs&metric=count')
        expect(list.map(p => p.bucket)).toEqual([...new Set([lastWeek.slice(0, 10), recent.slice(0, 10)])])
        expect(total(list)).toBe(3)
    })

    it('reaches back to the first run with range=all', async () => {
        const list = await points('dataset=runs&metric=count&range=all')
        expect(list[0].bucket).toBe(longAgo.slice(0, 10))
        expect(total(list)).toBe(4)
    })

    it('splits by group', async () => {
        const list = await points('dataset=runs&metric=count&groupBy=model&range=24h')
        expect(list.map(p => [p.group, p.value]).sort()).toEqual([
            ['model-a', 1],
            ['model-b', 1],
        ])
    })

    it('filters runs by status', async () => {
        expect(total(await points('dataset=runs&metric=count&range=all&status=error'))).toBe(1)
        expect(total(await points('dataset=runs&metric=count&range=all&status=all'))).toBe(4)
    })

    it('ignores the status filter outside the runs dataset', async () => {
        expect(total(await points('dataset=sessions&metric=count&range=all&status=error'))).toBe(1)
    })
})
