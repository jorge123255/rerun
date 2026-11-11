import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-foreman-alternates-'))
process.env.RERUN_HUB_BASE_URL = ''
process.env.RERUN_DESKTOP_APP = '1'
const { getSystemDb, closeSystemDb, SYSTEM_DB_VERSION } = await import('../../db/systemDb.js')
const { agentDir } = await import('../../config/paths.js')
const { reserveDesktopQueuedTurn } = await import('../../db/repos/desktop-queued-turns.js')
const { lookupForemanAlternate, prepareForemanAlternate } = await import('../../db/repos/foreman-alternate-sessions.js')
const { readForemanReplySource } = await import('../../db/repos/foreman-reply-sources.js')
const { appendMessage, listMessages } = await import('../../db/repos/messages.js')
const { cancelRun, finishRun, getRun } = await import('../../db/repos/runs.js')
const { getSession } = await import('../../db/repos/sessions.js')
const { claimSession, releaseSession } = await import('../../runtime/run-control.js')
const id = 'foreman'
const chat = { workspaceId: '1', chatId: 'fmc_alternate-test' }

beforeAll(async () => { await mkdir(agentDir(id), { recursive: true }); await getSystemDb(id) })
afterAll(async () => { closeSystemDb(id); await rm(process.env.RERUN_DATA_DIR!, { recursive: true, force: true }) })

async function queue(sessionId: string, first = false) {
    const runId = randomUUID()
    const foreman = { binding: { ...chat, runId, model: { connectionId: 'local', model: 'fixture' } },
        brief: { instructions: 'Synthetic setup.', tools: [] } }
    const user = await reserveDesktopQueuedTurn(id, { runId, sessionId, message: 'Same question.', foreman },
        undefined, undefined, undefined, first)
    return { runId, user }
}

async function complete(sessionId: string, turn: Awaited<ReturnType<typeof queue>>) {
    const reply = await appendMessage(id, sessionId, { role: 'assistant', content: 'Synthetic answer.' },
        undefined, undefined, { runId: turn.runId, userMessageId: turn.user.id })
    await finishRun(id, turn.runId, null, 1)
    return reply
}

async function source() {
    const sessionId = randomUUID(), first = await queue(sessionId, true)
    const reply = await complete(sessionId, first)
    const target = { ...chat, sessionId, assistantMessageId: reply.id }
    const proof = (await readForemanReplySource(target))!
    const request = { ...target, requestId: randomUUID(), transcriptRevision: proof.transcriptRevision }
    return { request, proof, first, reply }
}

test('prepares the exact saved prefix once and reopens it without starting a run', async () => {
    const { request, first, reply } = await source()
    const later = await queue(request.sessionId)
    await complete(request.sessionId, later)
    const { client } = await getSystemDb(id)
    await client.execute({ sql: "UPDATE messages SET created_at = 'same' WHERE session_id = ?", args: [request.sessionId] })
    const proof = (await readForemanReplySource(request))!
    const input = { ...request, transcriptRevision: proof.transcriptRevision }
    const original = await listMessages(id, request.sessionId)

    const [prepared, repeated] = await Promise.all([prepareForemanAlternate(input), prepareForemanAlternate(input)])
    expect(repeated).toEqual(prepared)
    expect(prepared.source).toMatchObject({ assistantMessageId: reply.id, sourceRunId: first.runId, precedingUserMessageId: first.user.id })
    expect(prepared.sessionId).not.toBe(request.sessionId)
    expect(prepared.runId).not.toBe(first.runId)
    expect(await getRun(id, prepared.runId)).toBeUndefined()
    expect(await getSession(id, prepared.sessionId)).toMatchObject({ agentId: id, originAgentId: id, originSessionId: request.sessionId, status: 'open' })
    const [copy, ...remaining] = await listMessages(id, prepared.sessionId)
    expect(remaining).toEqual([])
    expect(copy).toEqual({ ...original[0], id: prepared.userMessageId, sessionId: prepared.sessionId })
    expect(copy!.id).not.toBe(first.user.id)
    expect((await client.execute({ sql: 'SELECT content FROM messages_fts WHERE message_id = ?', args: [copy!.id] })).rows[0]?.content).toBe('Same question.')
    expect(await listMessages(id, request.sessionId)).toEqual(original)
    closeSystemDb(id)
    expect(await lookupForemanAlternate(input)).toEqual(prepared)
    expect(await getRun(id, prepared.runId)).toBeUndefined()
    expect((await (await getSystemDb(id)).client.execute('PRAGMA user_version')).rows[0]?.user_version).toBe(SYSTEM_DB_VERSION)
})

test('refuses stale or foreign sources and rejects reuse of a request for different work', async () => {
    const { request } = await source()
    for (const changes of [{ workspaceId: '2' }, { chatId: 'fmc_foreign-test' }, { assistantMessageId: randomUUID() }]) {
        await expect(prepareForemanAlternate({ ...request, ...changes })).rejects.toMatchObject({ status: 409 })
    }
    await appendMessage(id, request.sessionId, { role: 'user', content: 'Later message' })
    await expect(prepareForemanAlternate(request)).rejects.toMatchObject({ status: 409 })
    expect(await lookupForemanAlternate(request)).toBeNull()
    const proof = (await readForemanReplySource(request))!
    const fresh = { ...request, transcriptRevision: proof.transcriptRevision }
    const prepared = await prepareForemanAlternate(fresh)
    await expect(lookupForemanAlternate(request)).rejects.toMatchObject({ status: 409 })
    await expect(prepareForemanAlternate({ ...fresh, chatId: 'fmc_foreign-test' })).rejects.toMatchObject({ status: 409 })
    await appendMessage(id, request.sessionId, { role: 'user', content: 'Another later message' })
    expect(await lookupForemanAlternate(fresh)).toEqual(prepared)
})

test('refuses to prepare work while the original or an alternate owns a live claim or run', async () => {
    const { request } = await source()
    const live = await queue(request.sessionId)
    const proof = (await readForemanReplySource(request))!
    const current = { ...request, transcriptRevision: proof.transcriptRevision }
    await expect(prepareForemanAlternate(current)).rejects.toMatchObject({ status: 409 })
    await cancelRun(id, live.runId)

    const claim = randomUUID()
    expect(claimSession(request.sessionId, claim)).toBeNull()
    try { await expect(prepareForemanAlternate(current)).rejects.toMatchObject({ status: 409 }) }
    finally { releaseSession(claim) }
    const prepared = await prepareForemanAlternate(current)
    const another = { ...current, requestId: randomUUID() }
    expect(claimSession(prepared.sessionId, prepared.runId)).toBeNull()
    try { await expect(prepareForemanAlternate(another)).rejects.toMatchObject({ status: 409 }) }
    finally { releaseSession(prepared.runId) }
    const { client } = await getSystemDb(id)
    await client.execute({ sql: 'INSERT INTO runs (id,agent_id,session_id,started_at) VALUES (?,?,?,?)',
        args: [prepared.runId, id, prepared.sessionId, new Date().toISOString()] })
    await expect(prepareForemanAlternate(another)).rejects.toMatchObject({ status: 409 })
    expect(await lookupForemanAlternate(another)).toBeNull()
})

test('a failed prefix write leaves no session or receipt, and a damaged receipt never recreates one', async () => {
    const { request } = await source()
    const { client } = await getSystemDb(id)
    const linked = () => client.execute({ sql: 'SELECT id FROM sessions WHERE origin_session_id = ?', args: [request.sessionId] })
    await client.execute("CREATE TRIGGER fail_alternate_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic unavailable'); END")
    try {
        await expect(prepareForemanAlternate(request)).rejects.toThrow('synthetic unavailable')
        expect((await linked()).rows).toHaveLength(0)
        expect(await lookupForemanAlternate(request)).toBeNull()
    } finally { await client.execute('DROP TRIGGER fail_alternate_message') }
    const prepared = await prepareForemanAlternate(request)
    expect((await linked()).rows).toHaveLength(1)
    await client.execute({ sql: 'DELETE FROM messages WHERE id = ?', args: [prepared.userMessageId] })
    await expect(lookupForemanAlternate(request)).rejects.toMatchObject({ status: 409 })
    await expect(prepareForemanAlternate(request)).rejects.toMatchObject({ status: 409 })
    expect((await linked()).rows).toHaveLength(1)
})
