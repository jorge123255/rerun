import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { beforeAll, expect, it } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-completion-route-'))
const { runRoutes } = await import('./runs.js')
const { recordRunCompletion } = await import('../../db/completed-runs.js')
const app = new Hono().route('/agents/:id/runs', runRoutes)
const timestamp = '2100-01-01T00:00:00.000Z'
beforeAll(async () => {
    for (const agentId of ['owner-a', 'owner-b']) for (const runId of ['a__one', 'b__two', 'c__three']) {
        await recordRunCompletion({ agentId, sessionId: `${agentId}-chat`, runId, trigger: { source: 'chat' }, completedAt: timestamp, text: `${agentId}:${runId}` })
    }
})
const get = (query = '') => app.request(`/agents/owner-a/runs/completions${query}`)

it('supports exact bounded owner-scoped ID lookup rather than a recent-window approximation', async () => {
    const response = await get(`?ids=${encodeURIComponent(JSON.stringify(['a__one', 'c__three', 'missing']))}`)
    expect(response.status).toBe(200)
    expect((await response.json()).completions.map((row: { agentId: string; id: string }) => [row.agentId, row.id])).toEqual([['owner-a', 'c__three'], ['owner-a', 'a__one']])
})

it('round-trips raw IDs containing separators and supports inclusive tie reads for the next owner', async () => {
    const before = { completedAt: timestamp, id: 'b__two' }
    const strict = await get(`?before=${encodeURIComponent(JSON.stringify(before))}`)
    expect((await strict.json()).completions.map((row: { id: string }) => row.id)).toEqual(['a__one'])
    const inclusive = await get(`?before=${encodeURIComponent(JSON.stringify({ ...before, inclusiveId: true }))}`)
    expect((await inclusive.json()).completions.map((row: { id: string }) => row.id)).toEqual(['b__two', 'a__one'])
})

it.each([
    '?before=broken', '?before=' + encodeURIComponent(JSON.stringify({ completedAt: 'invalid', id: 'run' })),
    '?ids=broken', '?ids=' + encodeURIComponent(JSON.stringify([])),
    '?ids=' + encodeURIComponent(JSON.stringify(Array.from({ length: 101 }, (_, index) => String(index)))),
    '?ids=' + encodeURIComponent(JSON.stringify(['run'])) + '&before=' + encodeURIComponent(JSON.stringify({ completedAt: timestamp, id: 'run' })),
])('rejects malformed or oversized completion filters: %s', async query => {
    expect((await get(query)).status).toBe(400)
})
