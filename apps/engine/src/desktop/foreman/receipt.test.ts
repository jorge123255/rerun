import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-foreman-receipt-'))
process.env.RERUN_HUB_BASE_URL = ''
process.env.RERUN_DESKTOP_APP = '1'
const { getSystemDb, closeSystemDb } = await import('../../db/systemDb.js')
const { agentDir } = await import('../../config/paths.js')
const { reserveDesktopQueuedTurn, getDesktopQueuedTurn } = await import('../../db/repos/desktop-queued-turns.js')
const { appendMessage, listMessages } = await import('../../db/repos/messages.js')
const { cancelRun, failRun, finishRun, getRun } = await import('../../db/repos/runs.js')
const { getSession } = await import('../../db/repos/sessions.js')
const { readForemanReplySource } = await import('../../db/repos/foreman-reply-sources.js')
const { createDesktopForemanRoutes } = await import('./routes.js')
const { createDesktopForemanBridge } = await import('./bridge.js')
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

function replyTarget(input: ReturnType<typeof turn>, assistantMessageId: string) {
    const { workspaceId, chatId } = input.foreman.binding
    return { workspaceId, chatId, sessionId: input.sessionId, assistantMessageId }
}

async function saveReply(input: ReturnType<typeof turn>, userMessageId: string, text: string) {
    return appendMessage(id, input.sessionId, { role: 'assistant', content: text }, undefined, undefined,
        { runId: input.runId, userMessageId })
}

test('identical replies in one chat resolve to their own admitted turn after reopen', async () => {
    const first = turn()
    const next = turn()
    next.sessionId = first.sessionId
    const firstUser = await reserveDesktopQueuedTurn(id, first, undefined, undefined, undefined, true)
    const nextUser = await reserveDesktopQueuedTurn(id, next)
    const wrongUser = await saveReply(first, nextUser.id, 'Same response')
    const firstReply = await saveReply(first, firstUser.id, 'Same response')
    const nextReply = await saveReply(next, nextUser.id, 'Same response')
    const secondWrite = await saveReply(first, firstUser.id, 'Same response')
    const { client } = await getSystemDb(id)
    await client.execute({ sql: "UPDATE messages SET created_at = 'same' WHERE session_id = ?", args: [first.sessionId] })
    expect(await readForemanReplySource(replyTarget(first, firstReply.id))).toBeNull()
    await finishRun(id, first.runId, null, 1)
    await finishRun(id, next.runId, null, 1)
    closeSystemDb(id)
    expect(await getDesktopQueuedTurn(id, first)).toBe(true)
    for (const [input, reply, user] of [[first, firstReply, firstUser], [next, nextReply, nextUser]] as const) {
        const target = replyTarget(input, reply.id)
        expect(await readForemanReplySource(target)).toEqual({ ...target, sourceRunId: input.runId,
            precedingUserMessageId: user.id, replyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    }
    for (const row of [wrongUser, secondWrite]) expect(await readForemanReplySource(replyTarget(first, row.id))).toBeNull()
})

test('reply-source refuses a different owner, legacy rows and edited saved content', async () => {
    const input = turn()
    const user = await reserveDesktopQueuedTurn(id, input, undefined, undefined, undefined, true)
    const legacy = await appendMessage(id, input.sessionId, { role: 'assistant', content: 'Old saved answer' })
    const reply = await saveReply(input, user.id, 'A durable reply')
    await finishRun(id, input.runId, null, 1)
    const bridge = createDesktopForemanBridge({ workspaceId: 1, launchNonce: crypto.randomUUID(), app: { origin: 'http://127.0.0.1:3101' }, engine: { apiKey: 'a'.repeat(64) } })
    try {
        const app = createDesktopForemanRoutes(() => bridge)
        const target = replyTarget(input, reply.id)
        async function lookup(changes = {}) {
            const response = await app.request('/reply-source?' + new URLSearchParams({ ...target, ...changes }))
            expect(response.status).toBe(200)
            return response.json()
        }
        expect(await lookup()).toMatchObject({ source: { sourceRunId: input.runId, precedingUserMessageId: user.id } })
        for (const changes of [{ workspaceId: '2' }, { chatId: 'fmc_foreign-0001' }, { sessionId: crypto.randomUUID() }, { assistantMessageId: legacy.id }]) {
            expect(await lookup(changes)).toEqual({ source: null })
        }
        const { client } = await getSystemDb(id)
        await client.execute({ sql: 'UPDATE messages SET content_json = ? WHERE id = ?', args: ['"edited"', reply.id] })
        expect(await lookup()).toEqual({ source: null })
    } finally { bridge.close() }
})

test('cancelled or failed turns with saved text cannot claim a completed reply', async () => {
    for (const end of [cancelRun, (agent: string, run: string) => failRun(agent, run, 'synthetic error')]) {
        const input = turn()
        const user = await reserveDesktopQueuedTurn(id, input, undefined, undefined, undefined, true)
        const reply = await saveReply(input, user.id, 'Partial text')
        await end(id, input.runId)
        expect(await readForemanReplySource(replyTarget(input, reply.id))).toBeNull()
    }
})
