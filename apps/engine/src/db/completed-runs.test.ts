import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { RecordRunCompletionInput } from './completed-runs.js'

const dataRoot = mkdtempSync(resolve(tmpdir(), 'rerun-completed-runs-'))
const previousDesktop = process.env.RERUN_DESKTOP_APP
process.env.RERUN_DATA_DIR = dataRoot
process.env.RERUN_API_KEY = ''
process.env.RERUN_DESKTOP_APP = '1'

const { afterAll, describe, expect, it } = await import('vitest')
const { ensureRunCompletions, listRunCompletions, recordRunCompletion } = await import('./completed-runs.js')
const { closeSystemDb, getSystemDb } = await import('./systemDb.js')

const owners = new Set<string>()
const time = '2026-11-04T12:00:00.000Z'

function completion(agentId: string, runId: string, overrides: Partial<RecordRunCompletionInput> = {}): RecordRunCompletionInput {
    owners.add(agentId)
    return { agentId, sessionId: `${agentId}-chat`, runId, trigger: { source: 'chat' }, completedAt: time, ...overrides }
}

afterAll(() => {
    for (const owner of owners) closeSystemDb(owner)
    rmSync(dataRoot, { recursive: true, force: true })
    if (previousDesktop === undefined) delete process.env.RERUN_DESKTOP_APP
    else process.env.RERUN_DESKTOP_APP = previousDesktop
})

describe('desktop terminal completion records', () => {
    it('persists a terminal receipt and all metadata before resolving, including after close and reopen', async () => {
        const input = completion('persisted', 'run-persisted', {
            trigger: { source: 'schedule', slug: 'daily-report', name: 'Daily report' },
            text: '  The report is ready.  ', provider: 'codex', model: 'terra', costMicros: 0, stepCount: 3,
        })
        await recordRunCompletion(input)
        const first = await getSystemDb(input.agentId)
        closeSystemDb(input.agentId)
        expect(await getSystemDb(input.agentId)).not.toBe(first)
        expect(await listRunCompletions(input.agentId, { limit: 10 })).toEqual([{
            id: 'run-persisted', agentId: 'persisted', sessionId: 'persisted-chat', runId: 'run-persisted',
            source: 'schedule', slug: 'daily-report', sourceName: 'Daily report', completedAt: time, text: 'The report is ready.',
            provider: 'codex', model: 'terra', costMicros: 0, stepCount: 3,
        }])
    })

    it('upgrades existing receipts without inventing a name for old runs', async () => {
        const owner = 'legacy-receipts'
        owners.add(owner)
        const { client } = await getSystemDb(owner)
        await client.executeMultiple(`
            CREATE TABLE run_completions (
                id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, run_id TEXT, source TEXT,
                slug TEXT, completed_at TEXT, text TEXT, provider TEXT, model TEXT, cost_micros INTEGER, step_count INTEGER
            );
            INSERT INTO run_completions (id, agent_id, session_id, run_id, source, slug, completed_at)
                VALUES ('legacy', 'legacy-receipts', 'legacy-chat', 'legacy', 'schedule', 'digest', '2026-11-03T12:00:00.000Z');
        `)
        const [old] = await listRunCompletions(owner, { limit: 10 })
        expect(old).toMatchObject({ id: 'legacy', slug: 'digest' })
        expect(old).not.toHaveProperty('sourceName')
        await recordRunCompletion(completion(owner, 'current', { trigger: { source: 'schedule', slug: 'digest', name: 'Daily digest' } }))
        closeSystemDb(owner)
        expect(await listRunCompletions(owner, { limit: 10 })).toEqual([
            expect.objectContaining({ id: 'current', slug: 'digest', sourceName: 'Daily digest' }), old,
        ])
    })

    it('keeps the first terminal record when the same run is replayed with different text, metadata or session', async () => {
        const input = completion('idempotent', 'stable-terminal', {
            trigger: { source: 'trigger', slug: 'inbox', name: 'Inbox' },
            text: 'Original result', provider: 'codex', model: 'terra', costMicros: 12, stepCount: 2,
        })
        await recordRunCompletion(input)
        const original = await listRunCompletions(input.agentId, { limit: 10 })
        await Promise.all([
            recordRunCompletion({ ...input, text: 'Repeated terminal', stepCount: 99 }),
            recordRunCompletion({ ...input, sessionId: 'wrong-session', trigger: { source: 'chat' }, model: 'changed', completedAt: '2026-11-05T12:00:00.000Z' }),
        ])
        closeSystemDb(input.agentId)
        expect(await listRunCompletions(input.agentId, { limit: 10 })).toEqual(original)
        expect(original).toHaveLength(1)
        expect(original[0]).toMatchObject({ id: input.runId, sessionId: input.sessionId, text: 'Original result', slug: 'inbox', costMicros: 12 })
    })

    it('bounds the final text and preserves absent metadata and empty text honestly', async () => {
        await recordRunCompletion(completion('summaries', 'large', { text: `  ${'x'.repeat(2100)}  ` }))
        await recordRunCompletion(completion('summaries', 'empty', { text: ' \n\t ' }))
        const rows = await listRunCompletions('summaries', { limit: 10 })
        expect(rows.find(row => row.id === 'large')).toMatchObject({ text: 'x'.repeat(2000), slug: null, provider: null, model: null, costMicros: null, stepCount: null })
        expect(rows.find(row => row.id === 'empty')?.text).toBeNull()
    })

    it('isolates identical terminal IDs across coworkers and filters foreign rows even inside the selected database', async () => {
        await recordRunCompletion(completion('owner-a', 'shared-run-id', { text: 'A result' }))
        await recordRunCompletion(completion('owner-b', 'shared-run-id', { text: 'B result' }))
        const { client } = await getSystemDb('owner-a')
        await client.execute({
            sql: `INSERT INTO run_completions (id, agent_id, session_id, run_id, source, completed_at, text)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: ['foreign-receipt', 'owner-b', 'owner-b-chat', 'foreign-receipt', 'chat', time, 'Not owned by A'],
        })
        expect(await listRunCompletions('owner-a', { limit: 10, ids: ['shared-run-id', 'foreign-receipt'] })).toEqual([
            expect.objectContaining({ agentId: 'owner-a', id: 'shared-run-id', text: 'A result' }),
        ])
        expect(await listRunCompletions('owner-b', { limit: 10 })).toEqual([
            expect.objectContaining({ agentId: 'owner-b', id: 'shared-run-id', text: 'B result' }),
        ])
    })

    it('does not manufacture completion receipts from existing done, cancelled or failed run rows', async () => {
        const owner = 'no-terminal-event'
        owners.add(owner)
        const { client } = await getSystemDb(owner)
        for (const [id, status] of [['saved-done-without-terminal', 'done'], ['stopped', 'cancelled'], ['failed', 'error']]) {
            await client.execute({
                sql: 'INSERT INTO runs (id, agent_id, session_id, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
                args: [id, owner, 'existing-chat', status, time, time],
            })
        }
        expect(await listRunCompletions(owner, { limit: 10 })).toEqual([])
        await recordRunCompletion(completion(owner, 'genuine-terminal'))
        expect((await listRunCompletions(owner, { limit: 10 })).map(row => row.id)).toEqual(['genuine-terminal'])
    })
})

describe('bounded completion pagination', () => {
    it('paginates equal timestamps by descending terminal ID without skipping or repeating rows', async () => {
        for (const id of ['run-b', 'run-a', 'run-c']) await recordRunCompletion(completion('pages', id))
        await recordRunCompletion(completion('pages', 'older', { completedAt: '2026-11-04T11:59:59.000Z' }))
        await recordRunCompletion(completion('pages', 'newest', { completedAt: '2026-11-04T12:00:01.000Z' }))
        const first = await listRunCompletions('pages', { limit: 2 })
        expect(first.map(row => row.id)).toEqual(['newest', 'run-c'])
        const second = await listRunCompletions('pages', { limit: 2, before: { completedAt: first[1].completedAt, id: first[1].id } })
        expect(second.map(row => row.id)).toEqual(['run-b', 'run-a'])
        const third = await listRunCompletions('pages', { limit: 2, before: { completedAt: second[1].completedAt, id: second[1].id } })
        expect(third.map(row => row.id)).toEqual(['older'])
        expect(await listRunCompletions('pages', { limit: 2, before: { completedAt: third[0].completedAt, id: third[0].id } })).toEqual([])
    })

    it('includes the equal ID only when requested for a later coworker at the global cursor tie', async () => {
        await recordRunCompletion(completion('tie-a', 'shared'))
        await recordRunCompletion(completion('tie-b', 'shared'))
        await recordRunCompletion(completion('tie-b', 'a-before-shared'))
        await recordRunCompletion(completion('tie-b', 'z-after-shared'))
        const cursor = { completedAt: time, id: 'shared' }
        expect(await listRunCompletions('tie-a', { limit: 10, before: cursor })).toEqual([])
        expect((await listRunCompletions('tie-b', { limit: 10, before: cursor })).map(row => row.id)).toEqual(['a-before-shared'])
        expect((await listRunCompletions('tie-b', { limit: 10, before: { ...cursor, inclusiveId: true } })).map(row => row.id)).toEqual(['shared', 'a-before-shared'])
    })

    it('looks up only the requested exact identities, with deterministic order, cursor and limit', async () => {
        for (const id of ['a', 'b', 'c']) await recordRunCompletion(completion('lookup', id))
        expect(await listRunCompletions('lookup', { limit: 10, ids: [] })).toEqual([])
        expect(await listRunCompletions('lookup', { limit: 10, ids: ["a' OR 1=1 --", 'missing'] })).toEqual([])
        expect((await listRunCompletions('lookup', { limit: 10, ids: ['a', 'c', 'a', 'missing'] })).map(row => row.id)).toEqual(['c', 'a'])
        expect((await listRunCompletions('lookup', { limit: 1, ids: ['a', 'b', 'c'], before: { completedAt: time, id: 'c' } })).map(row => row.id)).toEqual(['b'])
    })

    it('caps a requested page at 200 records without changing newest-first order', async () => {
        const owner = 'bounded'
        owners.add(owner)
        const { client } = await getSystemDb(owner)
        await ensureRunCompletions(client)
        await client.execute({
            sql: `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 205)
                  INSERT INTO run_completions (id, agent_id, session_id, run_id, source, completed_at)
                  SELECT printf('run-%03d', n), ?, 'bounded-chat', printf('run-%03d', n), 'chat', ? FROM numbers`,
            args: [owner, time],
        })
        const rows = await listRunCompletions(owner, { limit: 1000 })
        expect(rows).toHaveLength(200)
        expect(rows[0].id).toBe('run-205')
        expect(rows[199].id).toBe('run-006')
        expect((await listRunCompletions(owner, { limit: 2.9 })).map(row => row.id)).toEqual(['run-205', 'run-204'])
    })
})
