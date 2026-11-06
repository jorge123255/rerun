import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'rerun-foreman-run-receipt-'))
process.env.RERUN_DATA_DIR = directory

vi.mock('../../agents/availability.js', () => ({ resolveRunModel: vi.fn() }))
vi.mock('../../runtime/loop.js', () => ({ runAgent: vi.fn() }))

const { Hono } = await import('hono')
const { runDetailSchema, runSchema } = await import('@rerun/contracts')
const { runRoutes } = await import('./runs.js')
const queuedTurns = await import('../../db/repos/desktop-queued-turns.js')
const { getSystemDb, closeSystemDb } = await import('../../db/systemDb.js')
const { createSession } = await import('../../db/repos/sessions.js')
const { resolveRunModel } = await import('../../agents/availability.js')
const { runAgent } = await import('../../runtime/loop.js')
const reserve = vi.spyOn(queuedTurns, 'reserveDesktopQueuedTurn')
const pointer = vi.spyOn(queuedTurns, 'getDesktopForemanQueuedUserMessageId')
const app = new Hono().route('/agents/:id/runs', runRoutes)
const foreman = 'foreman'
const ordinary = 'receiptordinary'

async function seed(agentId = foreman) {
    const sessionId = agentId === foreman ? randomUUID() : (await createSession(agentId)).id
    const runId = randomUUID()
    const turn = {
        runId, sessionId, message: 'These are my company intake answers: a saved exact kickoff.',
        ...(agentId === foreman ? {
            foreman: { binding: { workspaceId: '2', chatId: 'fmc_receipt-read-0001', runId, model: { connectionId: 'local-connection', model: 'chosen-model' } }, brief: { instructions: 'Propose a plan for review.', tools: [] } },
        } : {}),
    }
    const message = await queuedTurns.reserveDesktopQueuedTurn(agentId, turn, undefined, undefined, undefined, agentId === foreman)
    return { agentId, runId, sessionId, messageId: message.id }
}

async function read(input: Awaited<ReturnType<typeof seed>>) {
    const response = await app.request(`/agents/${input.agentId}/runs/${input.runId}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<Record<string, unknown>>
}

beforeEach(() => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.clearAllMocks()
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
    closeSystemDb(foreman)
    closeSystemDb(ordinary)
    await rm(directory, { recursive: true, force: true })
})

it('returns the exact queued user ID through the real run route after a database reopen', async () => {
    const input = await seed()
    closeSystemDb(foreman)
    const detail = await read(input)
    expect(runDetailSchema.parse(detail)).toMatchObject({ id: input.runId, agentId: foreman, sessionId: input.sessionId, queuedUserMessageId: input.messageId })
    expect(runSchema.parse(detail)).not.toHaveProperty('queuedUserMessageId')
    expect(await queuedTurns.getDesktopForemanQueuedUserMessageId(input.runId, randomUUID())).toBeNull()
})

it.each(['missing-receipt', 'missing-message', 'foreign-session', 'assistant-role', 'foreign-run-session'] as const)('omits the pointer for %s without guessing another message', async fault => {
    const input = await seed()
    const { client } = await getSystemDb(foreman)
    if (fault === 'missing-receipt') await client.execute({ sql: 'DELETE FROM desktop_queued_turns WHERE run_id=?', args: [input.runId] })
    if (fault === 'missing-message') await client.execute({ sql: 'DELETE FROM messages WHERE id=?', args: [input.messageId] })
    if (fault === 'foreign-session') await client.execute({ sql: 'UPDATE messages SET session_id=? WHERE id=?', args: [randomUUID(), input.messageId] })
    if (fault === 'assistant-role') await client.execute({ sql: "UPDATE messages SET role='assistant' WHERE id=?", args: [input.messageId] })
    if (fault === 'foreign-run-session') await client.execute({ sql: 'UPDATE runs SET session_id=? WHERE id=?', args: [randomUUID(), input.runId] })
    expect(await read(input)).not.toHaveProperty('queuedUserMessageId')
})

it('refuses a run indexed to a foreign agent rather than exposing its queued pointer', async () => {
    const input = await seed()
    const { client } = await getSystemDb(foreman)
    await client.execute({ sql: 'UPDATE runs SET agent_id=? WHERE id=?', args: [ordinary, input.runId] })
    expect(await queuedTurns.getDesktopForemanQueuedUserMessageId(input.runId, input.sessionId)).toBeNull()
    expect((await app.request(`/agents/${foreman}/runs/${input.runId}`)).status).toBe(404)
})

it('omits the pointer and does not consult the private mapping for hosted or ordinary runs', async () => {
    const hosted = await seed()
    const coworker = await seed(ordinary)
    pointer.mockClear()
    vi.stubEnv('RERUN_DESKTOP_APP', '0')
    expect(await read(hosted)).not.toHaveProperty('queuedUserMessageId')
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    expect(await read(coworker)).not.toHaveProperty('queuedUserMessageId')
    expect(pointer).not.toHaveBeenCalled()
})

it('reads the receipt on a query-only SQLite connection without reservation, model or execution effects', async () => {
    const input = await seed()
    const { client } = await getSystemDb(foreman)
    const before = await client.execute('SELECT total_changes() AS changes')
    reserve.mockClear()
    await client.execute('PRAGMA query_only=ON')
    try {
        expect(await read(input)).toMatchObject({ queuedUserMessageId: input.messageId })
    } finally {
        await client.execute('PRAGMA query_only=OFF')
    }
    expect((await client.execute('SELECT total_changes() AS changes')).rows).toEqual(before.rows)
    expect(reserve).not.toHaveBeenCalled()
    expect(resolveRunModel).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
})
