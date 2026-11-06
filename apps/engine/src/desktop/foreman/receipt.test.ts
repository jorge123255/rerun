import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-foreman-receipt-'))
process.env.RERUN_HUB_BASE_URL = ''
const { getSystemDb, closeSystemDb } = await import('../../db/systemDb.js')
const { agentDir } = await import('../../config/paths.js')
const { reserveDesktopQueuedTurn, getDesktopQueuedTurn } = await import('../../db/repos/desktop-queued-turns.js')
const { listMessages } = await import('../../db/repos/messages.js')
const { getRun } = await import('../../db/repos/runs.js')
const { getSession } = await import('../../db/repos/sessions.js')
const id = 'foreman'
function turn() { const runId = crypto.randomUUID(); return { runId, sessionId: crypto.randomUUID(), message: 'Plan my support team.', foreman: { binding: { workspaceId: '1', chatId: 'fmc_chat-0001', runId, model: { connectionId: 'connection', model: 'terra' } }, brief: { instructions: 'Show a plan, never confirm.', tools: [] } } } }
beforeAll(async () => { await mkdir(agentDir(id), { recursive: true }); await getSystemDb(id) })
afterAll(async () => { closeSystemDb(id); await rm(process.env.RERUN_DATA_DIR!, { recursive: true, force: true }) })
test('Foreman first turn commits its session and exact model/brief receipt and survives reopen', async () => {
    const input = turn(), saved = await reserveDesktopQueuedTurn(id, input, undefined, undefined, undefined, true)
    closeSystemDb(id)
    expect(await getDesktopQueuedTurn(id, input)).toBe(true)
    expect(await getSession(id, input.sessionId)).toMatchObject({ agentId: id, source: 'dashboard', status: 'open', originAgentId: null, originSessionId: null })
    expect(await getRun(id, input.runId)).toMatchObject({ agentId: id, sessionId: input.sessionId })
    expect((await listMessages(id, input.sessionId)).map(row => row.id)).toEqual([saved.id])
    for (const foreman of [
        { ...input.foreman, binding: { ...input.foreman.binding, model: { ...input.foreman.binding.model, model: 'other' } } },
        { ...input.foreman, binding: { ...input.foreman.binding, chatId: 'fmc_sibling-0001' } },
        { ...input.foreman, brief: { ...input.foreman.brief, instructions: 'Changed instructions' } },
    ]) await expect(getDesktopQueuedTurn(id, { ...input, foreman })).rejects.toMatchObject({ status: 409 })
})
test('failed first user persistence leaves no empty Foreman session, run or acceptance receipt', async () => {
    const input = turn(), { client } = await getSystemDb(id)
    await client.execute("CREATE TRIGGER fail_foreman_user BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'foreman user unavailable'); END")
    try {
        await expect(reserveDesktopQueuedTurn(id, input, undefined, undefined, undefined, true)).rejects.toThrow()
        expect(await getSession(id, input.sessionId)).toBeUndefined()
        expect(await getRun(id, input.runId)).toBeUndefined()
        expect(await getDesktopQueuedTurn(id, input)).toBe(false)
    } finally { await client.execute('DROP TRIGGER fail_foreman_user') }
})
