import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-chat-'))
process.env.RERUN_API_KEY = ''

const state = vi.hoisted(() => ({
    calls: [] as { agent: { id: string; brief?: unknown }; sessionId: string; message: string; override: unknown; runId: string; trigger?: { userLanguage?: string } }[],
    runAgentError: null as Error | null,
    startRunError: null as Error | null,
}))

vi.mock('../../runtime/loop.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../../runtime/loop.js')>()),
    runAgent: async (agent: { id: string; brief?: unknown }, sessionId: string, message: string, override: unknown, _writer: unknown, runId: string, trigger?: { userLanguage?: string }) => {
        state.calls.push({ agent, sessionId, message, override, runId, trigger })
        if (state.runAgentError) throw state.runAgentError
        const { releaseSession } = await import('../../runtime/run-control.js')
        releaseSession(runId)
        return {
            runId,
            settled: Promise.resolve({ kind: 'done' }),
            result: {
                toUIMessageStream: () =>
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue({ type: 'start' })
                            controller.enqueue({ type: 'text-start', id: 't' })
                            controller.enqueue({ type: 'text-delta', id: 't', delta: 'hello from the mock' })
                            controller.enqueue({ type: 'text-end', id: 't' })
                            controller.enqueue({ type: 'finish' })
                            controller.close()
                        },
                    }),
            },
        }
    },
}))

vi.mock('../../db/repos/runs.js', async importOriginal => {
    const original = await importOriginal<typeof import('../../db/repos/runs.js')>()
    return {
        ...original,
        startRun: (...args: Parameters<typeof original.startRun>) => (state.startRunError ? Promise.reject(state.startRunError) : original.startRun(...args)),
    }
})

const { describe, expect, it, beforeAll, beforeEach } = await import('vitest')
const { mkdir, writeFile } = await import('node:fs/promises')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir, installPath } = await import('../../config/paths.js')
const { createSession, getSession } = await import('../../db/repos/sessions.js')
const { getRun } = await import('../../db/repos/runs.js')
const { claimSession, releaseSession, sessionClaimCount } = await import('../../runtime/run-control.js')

const id = 'chatagent'
const app = createServer()

function chat(agentId: string, body: unknown) {
    return app.request(`/agents/${agentId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function seed(agentId: string, config: Record<string, unknown>) {
    await mkdir(agentDir(agentId), { recursive: true })
    await writeAgentConfig(agentId, agentConfigSchema.parse(config))
}

beforeAll(async () => {
    await seed(id, { name: 'chat' })
    await seed('sleepy', { name: 'sleepy', enabled: false })
    await seed('boss', { name: 'boss', kind: 'foreman' })
    await seed('installer', { name: 'installer', setup: { required: true } })
    await writeFile(installPath('installer'), 'Connect Gmail.\n', 'utf8')
})

beforeEach(() => {
    state.calls.length = 0
    state.runAgentError = null
    state.startRunError = null
})

describe('POST /agents/:id/chat', () => {
    async function pendingQuestion(sessionId: string) {
        const { appendMessage } = await import('../../db/repos/messages.js')
        const { findDesktopQuestion } = await import('@rerun/contracts')
        const ask = await appendMessage(id, sessionId, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'question-call', toolName: 'ask_user', input: { questions: [{ question: 'Which color?', options: ['Blue', 'Green'] }] } }] })
        const delivered = await appendMessage(id, sessionId, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'question-call', toolName: 'ask_user', output: { type: 'json', value: { status: 'delivered' } } }] })
        const { sourceMessageId, toolCallId, fingerprint } = findDesktopQuestion([ask, delivered])!
        return { sourceMessageId, toolCallId, fingerprint }
    }

    async function pendingApproval(sessionId: string) {
        const { appendMessage } = await import('../../db/repos/messages.js')
        const { findDesktopApproval } = await import('@rerun/contracts')
        const request = await appendMessage(id, sessionId, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'approval-call', toolName: 'request_approval', input: { approvals: [{ action: 'Use blue', detail: 'Main title' }, { action: 'Use green', detail: 'Subtitle' }] } }] })
        const delivered = await appendMessage(id, sessionId, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'approval-call', toolName: 'request_approval', output: { type: 'json', value: { status: 'delivered' } } }] })
        const { sourceMessageId, toolCallId, fingerprint } = findDesktopApproval([request, delivered])!
        return { sourceMessageId, toolCallId, fingerprint }
    }

    async function pendingServices(sessionId: string) {
        const { appendMessage } = await import('../../db/repos/messages.js')
        const { findDesktopServiceRequest } = await import('@rerun/contracts')
        const request = await appendMessage(id, sessionId, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'services-call', toolName: 'suggest_service', input: { services: [{ slug: 'notion', reason: 'Keep the report' }, { slug: 'slack', reason: 'Share the result' }] } }] })
        const delivered = await appendMessage(id, sessionId, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'services-call', toolName: 'suggest_service', output: { type: 'json', value: { status: 'delivered' } } }] })
        const { sourceMessageId, toolCallId, fingerprint } = findDesktopServiceRequest([request, delivered])!
        return { sourceMessageId, toolCallId, fingerprint }
    }

    it('admits the exact app result once, resumes after its source is settled, and binds replay to its guard kind', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const service = await pendingServices(session.id)
            const { serializeServiceSetupResult } = await import('@rerun/contracts')
            const message = serializeServiceSetupResult([{ slug: 'notion', name: 'Notion', outcome: 'skipped' }, { slug: 'slack', name: 'Slack', outcome: 'skipped' }])
            const input = { sessionId: session.id, message, desktopQueuedTurn: { runId: crypto.randomUUID(), service } }
            for (const response of await Promise.all([chat(id, input), chat(id, input)])) {
                expect([200, 204]).toContain(response.status)
                await response.text()
            }
            const { listMessages } = await import('../../db/repos/messages.js')
            expect((await listMessages(id, session.id)).filter(row => row.role === 'user')).toHaveLength(1)
            expect(state.calls).toHaveLength(1)
            const replay = await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            expect(replay.headers.get('x-run-id')).toBe(input.desktopQueuedTurn.runId)
            await replay.text()
            expect(state.calls).toHaveLength(1)
            for (const altered of [
                { ...input, message: 'Connected everything' },
                { ...input, desktopQueuedTurn: { runId: input.desktopQueuedTurn.runId } },
                { ...input, desktopQueuedTurn: { runId: input.desktopQueuedTurn.runId, approval: service } },
                { ...input, desktopQueuedTurn: { runId: input.desktopQueuedTurn.runId, service: { ...service, fingerprint: service.fingerprint + ' ' } } },
            ]) expect((await chat(id, altered)).status).toBe(409)
            for (const kind of ['question', 'approval', 'takeover']) {
                expect((await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, [kind]: service } })).status).toBe(400)
            }
        } finally { vi.unstubAllEnvs() }
    })

    it('blocks queued and ordinary messages behind app setup, but receipt probes stay read-only', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const service = await pendingServices(session.id)
            const queued = { sessionId: session.id, message: 'A saved draft', desktopQueuedTurn: { runId: crypto.randomUUID() } }
            for (const input of [queued, { sessionId: session.id, message: 'From an old panel' }, { ...queued, desktopQueuedTurn: { ...queued.desktopQueuedTurn, takeover: service } }]) {
                const response = await chat(id, input)
                expect(response.status).toBe(409)
                expect(await response.json()).toMatchObject({ code: 'service_pending' })
            }
            expect(await getRun(id, queued.desktopQueuedTurn.runId)).toBeUndefined()
            const probe = await chat(id, { ...queued, desktopQueuedTurn: { ...queued.desktopQueuedTurn, service, replayOnly: true } })
            expect(probe.status).toBe(404)
            expect(await probe.json()).toMatchObject({ code: 'queued_turn_not_found' })
            expect(state.calls).toHaveLength(0)
            expect(sessionClaimCount()).toBe(0)
            await (await chat(id, { sessionId: session.id, message: 'Skipped the requested apps.', desktopQueuedTurn: { runId: crypto.randomUUID(), service } })).text()
            const after = await chat(id, queued)
            expect(after.status).toBe(200)
            await after.text()
            expect(state.calls.map(call => call.message)).toEqual(['Skipped the requested apps.', queued.message])
        } finally { vi.unstubAllEnvs() }
    })

    it('rejects foreign and superseded app sources and permits an exact accepted replay after disable', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const enabled = (value: boolean) => app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: value }) })
        try {
            const session = await createSession(id), other = await createSession(id)
            const service = await pendingServices(session.id)
            const input = { sessionId: session.id, message: 'Skipped both apps.', desktopQueuedTurn: { runId: crypto.randomUUID(), service } }
            expect((await chat(id, { ...input, sessionId: other.id })).status).toBe(409)
            expect((await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, service: { ...service, sourceMessageId: 'different' } } })).status).toBe(409)
            await pendingQuestion(session.id)
            expect((await chat(id, input)).status).toBe(409)
            const fresh = await pendingServices(session.id)
            const accepted = { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, service: fresh } }
            await (await chat(id, accepted)).text()
            expect((await enabled(false)).status).toBe(200)
            const replay = await chat(id, { ...accepted, desktopQueuedTurn: { ...accepted.desktopQueuedTurn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            await replay.text()
            const missing = crypto.randomUUID()
            expect((await chat(id, { ...accepted, desktopQueuedTurn: { runId: missing, service: fresh, replayOnly: true } })).status).toBe(403)
            expect(await getRun(id, missing)).toBeUndefined()
            expect(state.calls).toHaveLength(1)
            expect(sessionClaimCount()).toBe(0)
        } finally { await enabled(true); vi.unstubAllEnvs() }
    })

    it('accepts mixed approval decisions once and binds receipt replay to the approval kind and exact content', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const approval = await pendingApproval(session.id)
            const { serializeApprovalDecisions } = await import('@rerun/contracts')
            const message = serializeApprovalDecisions([{ action: 'Use blue', detail: 'Main title', decision: 'approved' }, { action: 'Use green', detail: 'Subtitle', decision: 'declined', note: 'Keep the subtitle plain.' }])
            const input = { sessionId: session.id, message, desktopQueuedTurn: { runId: crypto.randomUUID(), approval } }
            const responses = await Promise.all([chat(id, input), chat(id, input)])
            for (const response of responses) {
                expect([200, 204]).toContain(response.status)
                await response.text()
            }
            const { listMessages } = await import('../../db/repos/messages.js')
            const users = (await listMessages(id, session.id)).filter(row => row.role === 'user')
            expect(users).toHaveLength(1)
            expect(users[0].contentJson).toContain('Keep the subtitle plain.')
            expect(state.calls).toHaveLength(1)
            expect(state.calls[0].message).toBe(message)
            const replay = await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            await replay.text()
            expect(state.calls).toHaveLength(1)
            expect((await chat(id, { ...input, message: 'Approve everything' })).status).toBe(409)
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: input.desktopQueuedTurn.runId, question: approval } })).status).toBe(409)
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: input.desktopQueuedTurn.runId } })).status).toBe(409)
            expect((await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, question: approval } })).status).toBe(400)
        } finally { vi.unstubAllEnvs() }
    })

    it('rejects stale, foreign and changed approval guards, including a newer request of the other kind', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const other = await createSession(id)
            const question = await pendingQuestion(session.id)
            const approval = await pendingApproval(session.id)
            const send = (sessionId: string, guard = approval) => {
                const runId = crypto.randomUUID()
                return { runId, response: chat(id, { sessionId, message: 'Approved', desktopQueuedTurn: { runId, approval: guard } }) }
            }
            for (const attempt of [send(other.id), send(session.id, { ...approval, fingerprint: approval.fingerprint + ' ' }), send(session.id, { ...approval, sourceMessageId: 'another-message' })]) {
                expect((await attempt.response).status).toBe(409)
                expect(await getRun(id, attempt.runId)).toBeUndefined()
            }
            expect((await chat(id, { sessionId: session.id, message: 'Blue', desktopQueuedTurn: { runId: crypto.randomUUID(), question } })).status).toBe(409)
            await pendingQuestion(session.id)
            const superseded = send(session.id)
            expect((await superseded.response).status).toBe(409)
            expect(await getRun(id, superseded.runId)).toBeUndefined()
            const { appendMessage, listMessages } = await import('../../db/repos/messages.js')
            const newer = await pendingApproval(session.id)
            await appendMessage(id, session.id, { role: 'user', content: 'I already replied elsewhere.' })
            expect((await send(session.id, newer).response).status).toBe(409)
            expect((await listMessages(id, session.id)).filter(row => row.role === 'user')).toHaveLength(1)
            expect(state.calls).toHaveLength(0)
            expect(sessionClaimCount()).toBe(0)
        } finally { vi.unstubAllEnvs() }
    })

    it('blocks queued and ordinary desktop sends behind a pending approval without reserving either run', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const approval = await pendingApproval(session.id)
            const queued = { sessionId: session.id, message: 'Saved follow-up', desktopQueuedTurn: { runId: crypto.randomUUID() } }
            for (const input of [queued, { sessionId: session.id, message: 'From a stale panel' }]) {
                const response = await chat(id, input)
                expect(response.status).toBe(409)
                expect(await response.json()).toMatchObject({ code: 'approval_pending' })
            }
            expect(await getRun(id, queued.desktopQueuedTurn.runId)).toBeUndefined()
            const { getSystemDb } = await import('../../db/systemDb.js')
            const { client } = await getSystemDb(id)
            expect(Number((await client.execute({ sql: 'SELECT COUNT(*) AS total FROM runs WHERE session_id = ?', args: [session.id] })).rows[0].total)).toBe(0)
            expect(sessionClaimCount()).toBe(0)
            expect(state.calls).toHaveLength(0)
            await (await chat(id, { sessionId: session.id, message: 'Declined both actions.', desktopQueuedTurn: { runId: crypto.randomUUID(), approval } })).text()
            const after = await chat(id, queued)
            expect(after.status).toBe(200)
            await after.text()
            expect(state.calls.map(call => call.message)).toEqual(['Declined both actions.', queued.message])
        } finally { vi.unstubAllEnvs() }
    })

    it('reconciles an accepted approval after disable without dispatching an unaccepted decision', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const enabled = (value: boolean) => app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: value }) })
        try {
            const session = await createSession(id)
            const approval = await pendingApproval(session.id)
            const input = { sessionId: session.id, message: 'Declined both actions.', desktopQueuedTurn: { runId: crypto.randomUUID(), approval } }
            await (await chat(id, input)).text()
            expect((await enabled(false)).status).toBe(200)
            const replay = await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            expect(replay.headers.get('x-run-id')).toBe(input.desktopQueuedTurn.runId)
            await replay.text()
            const missing = crypto.randomUUID()
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: missing, approval, replayOnly: true } })).status).toBe(403)
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: missing, approval } })).status).toBe(403)
            expect((await chat(id, { ...input, message: 'Approved', desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })).status).toBe(409)
            expect(await getRun(id, missing)).toBeUndefined()
            expect(state.calls).toHaveLength(1)
            expect(sessionClaimCount()).toBe(0)
        } finally {
            await enabled(true)
            vi.unstubAllEnvs()
        }
    })

    it('reserves a question answer once and replays the receipt after the question is no longer pending', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const question = await pendingQuestion(session.id)
            const input = { sessionId: session.id, message: 'Here are my answers:\n\n**Which color?**\nBlue', desktopQueuedTurn: { runId: crypto.randomUUID(), question } }
            const responses = await Promise.all([chat(id, input), chat(id, input)])
            for (const response of responses) {
                expect([200, 204]).toContain(response.status)
                await response.text()
            }
            const { listMessages } = await import('../../db/repos/messages.js')
            expect((await listMessages(id, session.id)).filter(row => row.role === 'user')).toHaveLength(1)
            expect(state.calls).toHaveLength(1)
            const replay = await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            await replay.text()
            expect(state.calls).toHaveLength(1)
            expect((await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, question: { ...question, toolCallId: 'another-call' } } })).status).toBe(409)
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: input.desktopQueuedTurn.runId } })).status).toBe(409)
        } finally { vi.unstubAllEnvs() }
    })

    it('rejects stale, altered or foreign question guards without reserving a run or keeping the claim', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const other = await createSession(id)
            const question = await pendingQuestion(session.id)
            const { appendMessage, listMessages } = await import('../../db/repos/messages.js')
            const send = (sessionId: string, guard = question) => {
                const runId = crypto.randomUUID()
                return { runId, response: chat(id, { sessionId, message: 'Blue', desktopQueuedTurn: { runId, question: guard } }) }
            }
            for (const attempt of [send(other.id), send(session.id, { ...question, fingerprint: question.fingerprint + ' ' })]) {
                expect((await attempt.response).status).toBe(409)
                expect(await getRun(id, attempt.runId)).toBeUndefined()
            }
            await appendMessage(id, session.id, { role: 'user', content: 'Never mind, a different request.' })
            const stale = send(session.id)
            expect((await stale.response).status).toBe(409)
            expect(await getRun(id, stale.runId)).toBeUndefined()
            expect((await listMessages(id, session.id)).filter(row => row.role === 'user')).toHaveLength(1)
            expect(state.calls).toHaveLength(0)
            expect(sessionClaimCount()).toBe(0)
        } finally { vi.unstubAllEnvs() }
    })

    it('reconciles an accepted question after disable but cannot dispatch a missing receipt or new answer', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const enabled = (value: boolean) => app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: value }) })
        try {
            const session = await createSession(id)
            const question = await pendingQuestion(session.id)
            const input = { sessionId: session.id, message: 'Blue', desktopQueuedTurn: { runId: crypto.randomUUID(), question } }
            await (await chat(id, input)).text()
            expect(state.calls).toHaveLength(1)
            expect((await enabled(false)).status).toBe(200)
            const replay = await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            expect(replay.headers.get('x-run-id')).toBe(input.desktopQueuedTurn.runId)
            await replay.text()
            const missing = crypto.randomUUID()
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: missing, question, replayOnly: true } })).status).toBe(403)
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: missing, question } })).status).toBe(403)
            expect((await chat(id, { ...input, message: 'Green', desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })).status).toBe(409)
            expect(await getRun(id, missing)).toBeUndefined()
            expect(state.calls).toHaveLength(1)
            expect(sessionClaimCount()).toBe(0)
        } finally {
            await enabled(true)
            vi.unstubAllEnvs()
        }
    })

    it('holds the session claim while validating a question so a normal send cannot race the answer', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const messages = await import('../../db/repos/messages.js')
        let releaseRead!: () => void
        const blocked = new Promise<void>(resolve => { releaseRead = resolve })
        let observedRead!: () => void
        const observed = new Promise<void>(resolve => { observedRead = resolve })
        let restore = () => {}
        try {
            const session = await createSession(id)
            const question = await pendingQuestion(session.id)
            const original = messages.listMessages
            const spy = vi.spyOn(messages, 'listMessages').mockImplementationOnce(async (...args) => {
                const rows = await original(...args)
                observedRead()
                await blocked
                return rows
            })
            restore = () => spy.mockRestore()
            const answer = chat(id, { sessionId: session.id, message: 'Blue', desktopQueuedTurn: { runId: crypto.randomUUID(), question } })
            await observed
            const competing = await chat(id, { sessionId: session.id, message: 'A different request' })
            expect(competing.status).toBe(409)
            releaseRead()
            const accepted = await answer
            expect(accepted.status).toBe(200)
            await accepted.text()
            expect((await original(id, session.id)).filter(row => row.role === 'user')).toHaveLength(1)
            expect(state.calls).toHaveLength(1)
        } finally { releaseRead(); restore(); vi.unstubAllEnvs() }
    })

    it('holds a queued draft when a question was saved after the panel snapshot, without blocking accepted receipt replay', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const first = { sessionId: session.id, message: 'Please ask me before continuing.', desktopQueuedTurn: { runId: crypto.randomUUID() } }
            await (await chat(id, first)).text()
            // The panel has already read question:null. The prior run now saves its question
            // before the panel's first status check observes idle and tries to drain its queue.
            const question = await pendingQuestion(session.id)
            const queued = { sessionId: session.id, message: 'Saved follow-up', desktopQueuedTurn: { runId: crypto.randomUUID() } }
            const blocked = await chat(id, queued)
            expect(blocked.status).toBe(409)
            expect(await blocked.json()).toMatchObject({ code: 'question_pending' })
            expect(await getRun(id, queued.desktopQueuedTurn.runId)).toBeUndefined()
            expect(sessionClaimCount()).toBe(0)
            expect(state.calls).toHaveLength(1)
            const replay = await chat(id, first)
            expect([200, 204]).toContain(replay.status)
            await replay.text()
            expect(state.calls).toHaveLength(1)
            await (await chat(id, { sessionId: session.id, message: 'Blue', desktopQueuedTurn: { runId: crypto.randomUUID(), question } })).text()
            const retry = await chat(id, queued)
            expect(retry.status).toBe(200)
            await retry.text()
            expect(state.calls.map(call => call.message)).toEqual([first.message, 'Blue', queued.message])
            const { listMessages } = await import('../../db/repos/messages.js')
            expect((await listMessages(id, session.id)).filter(row => row.role === 'user')).toHaveLength(3)
        } finally { vi.unstubAllEnvs() }
    })

    it('refuses an ordinary desktop message while a saved question is pending, without creating a run or holding the session', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            await pendingQuestion(session.id)
            const response = await chat(id, { sessionId: session.id, message: 'A message from a stale panel snapshot' })
            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({ code: 'question_pending' })
            expect(state.calls).toHaveLength(0)
            expect(sessionClaimCount()).toBe(0)
            const { getSystemDb } = await import('../../db/systemDb.js')
            const { client } = await getSystemDb(id)
            const runs = await client.execute({ sql: 'SELECT COUNT(*) AS total FROM runs WHERE session_id = ?', args: [session.id] })
            expect(Number(runs.rows[0].total)).toBe(0)
            const { listMessages } = await import('../../db/repos/messages.js')
            expect((await listMessages(id, session.id)).filter(row => row.role === 'user')).toHaveLength(0)
        } finally { vi.unstubAllEnvs() }
    })

    it('reserves one queued run and durable user row for concurrent requests and lost acknowledgements', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const session = await createSession(id)
            const other = await createSession(id)
            const runId = crypto.randomUUID()
            const input = { sessionId: session.id, message: 'Only one follow-up', desktopQueuedTurn: { runId } }
            const responses = await Promise.all([chat(id, input), chat(id, input)])
            for (const response of responses) {
                expect([200, 204]).toContain(response.status)
                expect(response.headers.get('x-run-id')).toBe(runId)
                expect(response.headers.get('x-session-id')).toBe(session.id)
                await response.text()
            }
            expect(state.calls).toHaveLength(1)
            expect(state.calls[0].trigger).toHaveProperty('queuedUser')
            const { listMessages } = await import('../../db/repos/messages.js')
            expect((await listMessages(id, session.id)).filter(row => row.role === 'user')).toHaveLength(1)
            expect((await listMessages(id, session.id))[0].contentJson).toContain('Only one follow-up')
            const replay = await chat(id, { ...input, desktopQueuedTurn: { runId, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            await replay.text()
            expect(state.calls).toHaveLength(1)
            expect((await chat(id, { ...input, message: 'Changed text' })).status).toBe(409)
            expect((await chat(id, { ...input, sessionId: other.id })).status).toBe(409)
            expect((await chat(id, { ...input, desktopQueuedTurn: { runId: 'bad' } })).status).toBe(400)
            expect((await chat(id, { ...input, sessionId: undefined })).status).toBe(400)
        } finally { vi.unstubAllEnvs() }
    })

    it('never acknowledges a failed queued reservation and retries after the transaction rolls back', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const { getSystemDb } = await import('../../db/systemDb.js')
        const { client } = await getSystemDb(id)
        try {
            const session = await createSession(id)
            const input = { sessionId: session.id, message: 'Keep this draft', desktopQueuedTurn: { runId: crypto.randomUUID() } }
            await client.execute("CREATE TRIGGER reject_queued_user BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'unavailable'); END")
            const failed = await Promise.all([chat(id, input), chat(id, input)])
            expect(failed.map(response => response.status)).toEqual([500, 500])
            expect(state.calls).toHaveLength(0)
            expect(await getRun(id, input.desktopQueuedTurn.runId)).toBeUndefined()
            await client.execute('DROP TRIGGER reject_queued_user')
            const retry = await chat(id, input)
            expect(retry.status).toBe(200)
            await retry.text()
            expect(state.calls).toHaveLength(1)
        } finally {
            await client.execute('DROP TRIGGER IF EXISTS reject_queued_user')
            vi.unstubAllEnvs()
        }
    })

    it('a queued probe cannot start a run, and a busy session leaves the requested ID unreserved', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const holder = crypto.randomUUID()
        try {
            const session = await createSession(id)
            const input = { sessionId: session.id, message: 'Wait for it', desktopQueuedTurn: { runId: crypto.randomUUID() } }
            expect((await chat(id, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })).status).toBe(404)
            claimSession(session.id, holder)
            expect((await chat(id, input)).status).toBe(409)
            expect(await getRun(id, input.desktopQueuedTurn.runId)).toBeUndefined()
            expect(state.calls).toHaveLength(0)
            releaseSession(holder)
            await (await chat(id, input)).text()
            expect(state.calls).toHaveLength(1)
        } finally { releaseSession(holder); vi.unstubAllEnvs() }
    })
    it('dispatches one first turn for simultaneous retries of a desktop tab', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const first = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID() }
            const input = { message: 'Only once', desktopFirstTurn: first }
            const responses = await Promise.all([chat(id, input), chat(id, input)])
            for (const response of responses) {
                expect([200, 204]).toContain(response.status)
                expect(response.headers.get('x-session-id')).toBe(first.sessionId)
                expect(response.headers.get('x-run-id')).toBe(first.runId)
                await response.text()
            }
            expect(state.calls).toHaveLength(1)
            expect(state.calls[0].trigger).toHaveProperty('queuedUser')
            const { listMessages } = await import('../../db/repos/messages.js')
            expect((await listMessages(id, first.sessionId)).filter(row => row.role === 'user')).toHaveLength(1)
            expect(await getRun(id, first.runId)).toMatchObject({ sessionId: first.sessionId })
            expect((await chat(id, { ...input, message: 'Different first message' })).status).toBe(409)
            expect((await chat(id, { ...input, desktopFirstTurn: { ...first, runId: crypto.randomUUID() } })).status).toBe(409)
            expect((await chat(id, { ...input, sessionId: first.sessionId })).status).toBe(400)
            expect(state.calls).toHaveLength(1)
        } finally { vi.unstubAllEnvs() }
    })
    it('preserves a first message when provider preparation fails and never sends it again on replay', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const first = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID() }
            const workspaceAttachment = { path: 'brief.md', content: 'Keep this snapshot' }
            const input = { message: 'Read my brief exactly once', workspaceAttachment, desktopFirstTurn: first }
            state.runAgentError = new Error('provider preparation failed')
            const initial = await chat(id, input)
            expect(initial.status).toBe(200)
            await initial.text()
            const { listMessages } = await import('../../db/repos/messages.js')
            const saved = await listMessages(id, first.sessionId)
            expect(saved).toHaveLength(1)
            expect(saved[0].contentJson).toContain('Keep this snapshot')
            state.runAgentError = null
            const replay = await chat(id, input)
            expect([200, 204]).toContain(replay.status)
            await replay.text()
            expect(state.calls).toHaveLength(1)
            expect((await listMessages(id, first.sessionId)).map(row => row.id)).toEqual([saved[0].id])
            expect((await chat(id, { ...input, workspaceAttachment: { ...workspaceAttachment, content: 'Replacement bytes' } })).status).toBe(409)
        } finally { vi.unstubAllEnvs() }
    })

    it('cannot acknowledge a first-turn receipt when saving its user row fails', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const { getSystemDb } = await import('../../db/systemDb.js')
        const { client } = await getSystemDb(id)
        const first = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID() }
        const input = { message: 'Keep my unsent first draft', desktopFirstTurn: first }
        try {
            await client.execute("CREATE TRIGGER fail_first_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'cannot save'); END")
            expect((await chat(id, input)).status).toBe(500)
            expect(await getSession(id, first.sessionId)).toBeUndefined()
            expect(await getRun(id, first.runId)).toBeUndefined()
            expect(state.calls).toHaveLength(0)
            await client.execute('DROP TRIGGER fail_first_message')
            const retry = await chat(id, input)
            expect(retry.status).toBe(200)
            await retry.text()
            expect(state.calls).toHaveLength(1)
        } finally {
            await client.execute('DROP TRIGGER IF EXISTS fail_first_message')
            vi.unstubAllEnvs()
        }
    })
    it('forwards validated attachment snapshots only on desktop', async () => {
        const workspaceAttachment = { path: 'folder/brief.md', content: 'First line\nA durable second line.' }
        const body = { message: 'What is the second line?', workspaceAttachment }
        await (await chat(id, body)).text()
        expect(state.calls[0].trigger).not.toHaveProperty('workspaceAttachment', workspaceAttachment)
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            expect((await chat(id, { ...body, workspaceAttachment: { ...workspaceAttachment, path: '../brief.md' } })).status).toBe(400)
            expect((await chat(id, { ...body, workspaceAttachment: { ...workspaceAttachment, content: 'é'.repeat(17 * 1024) } })).status).toBe(400)
            expect(state.calls).toHaveLength(1)
            const res = await chat(id, body)
            expect(res.status).toBe(200)
            await res.text()
            expect(state.calls[1]).toMatchObject({ message: body.message, trigger: { workspaceAttachment } })
        } finally { vi.unstubAllEnvs() }
    })

    it('forwards an ordered multi-file snapshot and refuses more than 128 KiB combined', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const first = { path: 'folder/a.md', content: 'Alpha' }
            const second = { path: 'folder/b.txt', content: 'Beta' }
            const response = await chat(id, { message: 'Compare both', workspaceAttachments: [first, second] })
            expect(response.status).toBe(200)
            await response.text()
            expect(state.calls[0]).toMatchObject({ message: 'Compare both', trigger: { workspaceAttachments: [first, second] } })
            expect(state.calls[0].trigger).not.toHaveProperty('workspaceAttachment')
            expect((await chat(id, { message: 'Twice', workspaceAttachments: [first, first] })).status).toBe(400)
            const heavy = Array.from({ length: 5 }, (_, index) => ({ path: `folder/h${index}.md`, content: 'A'.repeat(32 * 1024) }))
            expect((await chat(id, { message: 'Too much', workspaceAttachments: heavy })).status).toBe(400)
            expect((await chat(id, { message: 'Eleven', workspaceAttachments: Array.from({ length: 11 }, () => first) })).status).toBe(400)
            expect(state.calls).toHaveLength(1)
        } finally { vi.unstubAllEnvs() }
    })

    it.each(['Read the image', ''])('admits verified image bytes and exact replay with text %j, but rejects another provider', async message => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const availability = await import('../../agents/availability.js')
        const resolveModel = vi.spyOn(availability, 'resolveRunModel').mockResolvedValue({ provider: 'codex', model: 'image-test', connection: null })
        const { createHash } = await import('node:crypto')
        const { desktopAttachmentFieldsOf, desktopResolvedAttachmentSelections } = await import('@rerun/contracts')
        const dataBase64 = Buffer.from('pinned bytes').toString('base64')
        const image = { sha256: createHash('sha256').update(Buffer.from(dataBase64, 'base64')).digest('hex'), name: 'shot.png', path: 'shot.png', mediaType: 'image/png' as const, width: 1, height: 1, byteLength: 12 }
        const desktopAttachments = [{ type: 'text' as const, path: 'notes.md', content: 'Frozen notes' }, { type: 'image' as const, image, dataBase64 }]
        const first = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID() }
        try {
            const initial = await chat(id, { message, desktopFirstTurn: first, desktopAttachments })
            expect(initial.status).toBe(200)
            await initial.text()
            const { listMessages } = await import('../../db/repos/messages.js')
            expect(JSON.parse((await listMessages(id, first.sessionId))[0].contentJson).find((part: { type: string }) => part.type === 'file')).toMatchObject({ data: dataBase64, mediaType: 'image/png' })
            const queued = { runId: crypto.randomUUID(), ...desktopAttachmentFieldsOf(desktopResolvedAttachmentSelections(desktopAttachments)) }
            const sent = await chat(id, { sessionId: first.sessionId, message, desktopQueuedTurn: queued, desktopAttachments })
            expect(sent.status).toBe(200)
            await sent.text()
            // A receipt probe omits image bytes and still reconciles the exact accepted identity.
            expect([200, 204]).toContain((await chat(id, { sessionId: first.sessionId, message, desktopQueuedTurn: { ...queued, replayOnly: true } })).status)
            const refused = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID() }
            resolveModel.mockResolvedValue({ provider: 'rerun', model: 'text-only-test', connection: null })
            expect((await chat(id, { message, desktopFirstTurn: refused, desktopAttachments })).status).toBe(400)
            expect(await getRun(id, refused.runId)).toBeUndefined()
            expect(await getSession(id, refused.sessionId)).toBeUndefined()
            const followup = { runId: crypto.randomUUID() }
            expect((await chat(id, { sessionId: first.sessionId, message: 'Continue', desktopQueuedTurn: followup })).status).toBe(400)
            expect(await getRun(id, followup.runId)).toBeUndefined()
            resolveModel.mockResolvedValue({ provider: 'codex', model: 'image-test', connection: null })
            expect((await chat(id, { message: 'Tampered bytes', desktopFirstTurn: refused, desktopAttachments: [{ type: 'image', image, dataBase64: 'Y2hhbmdlZA==' }] })).status).toBe(400)
            expect(await getRun(id, refused.runId)).toBeUndefined()
            expect(state.calls).toHaveLength(2)
            expect(state.calls[0].message).toBe(message)
            expect(state.calls[1].message).toBe(message)
        } finally { resolveModel.mockRestore(); vi.unstubAllEnvs() }
    })

    it('binds question images to a verified answer and enforces the selected model on new and saved images', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const availability = await import('../../agents/availability.js')
        const resolveModel = vi.spyOn(availability, 'resolveRunModel').mockResolvedValue({ provider: 'openrouter', model: 'text-fixture', connection: null })
        const { createHash } = await import('node:crypto')
        const { listMessages } = await import('../../db/repos/messages.js')
        const { desktopStoredDocumentReferences } = await import('@rerun/contracts')
        try {
            const session = await createSession(id)
            const question = await pendingQuestion(session.id)
            const data = Buffer.from('question image')
            const reference = {
                attachmentId: crypto.randomUUID(), scope: { agentId: 'desktop-agent', sessionId: 'local-chat', tabUid: 'question:' + 'a'.repeat(64) },
                name: 'sample.png', mimeType: 'image/png', kind: 'image', byteLength: data.length,
                sha256: createHash('sha256').update(data).digest('hex'),
            }
            const documents = { scope: reference.scope, attachmentIds: [reference.attachmentId], admissionId: crypto.randomUUID() }
            const turn = { runId: crypto.randomUUID(), question, documents }
            const image = { reference, dataBase64: data.toString('base64') }
            const body = { sessionId: session.id, message: 'Here is the image.', desktopQueuedTurn: turn, desktopDocuments: [image] }
            expect((await chat(id, { ...body, desktopQueuedTurn: { runId: turn.runId, documents } })).status).toBe(400)
            expect((await chat(id, { ...body, desktopDocuments: [{ ...image, dataBase64: 'c3dhcHBlZA==' }] })).status).toBe(400)
            expect((await chat(id, body)).status).toBe(400)
            expect(await getRun(id, turn.runId)).toBeUndefined()
            expect(state.calls).toHaveLength(0)

            resolveModel.mockResolvedValue({ provider: 'codex', model: 'vision-fixture', connection: null })
            const response = await chat(id, body)
            expect(response.status).toBe(200)
            await response.text()
            const user = (await listMessages(id, session.id)).find(row => row.role === 'user')
            const content = JSON.parse(user!.contentJson)
            expect(content).toContainEqual({ type: 'file', data: image.dataBase64, filename: reference.name,
                mediaType: reference.mimeType, providerOptions: { rerun: { desktopDocument: reference } } })
            expect(desktopStoredDocumentReferences(content)).toEqual([reference])

            resolveModel.mockResolvedValue({ provider: 'openrouter', model: 'text-fixture', connection: null })
            const replay = await chat(id, { sessionId: session.id, message: body.message, desktopQueuedTurn: { ...turn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            expect((await chat(id, { sessionId: session.id, message: 'Continue with a text-only model.' })).status).toBe(400)
            expect(state.calls).toHaveLength(1)
        } finally { resolveModel.mockRestore(); vi.unstubAllEnvs() }
    })

    it('rejects empty desktop runs and unresolved attachment identities, but permits read-only reconciliation', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            expect((await chat(id, { message: '' })).status).toBe(400)
            expect((await chat(id, { message: '   ' })).status).toBe(400)
            expect((await chat(id, { message: '', workspaceAttachments: [] })).status).toBe(400)
            const session = await createSession(id)
            const queued = { runId: crypto.randomUUID(), attachmentPath: 'notes.md' }
            expect((await chat(id, { sessionId: session.id, message: '', desktopQueuedTurn: queued })).status).toBe(400)
            const probe = await chat(id, { sessionId: session.id, message: '', desktopQueuedTurn: { ...queued, replayOnly: true } })
            expect(probe.status).toBe(404)
            expect(await getRun(id, queued.runId)).toBeUndefined()
            expect(state.calls).toHaveLength(0)
        } finally { vi.unstubAllEnvs() }
    })

    it('404s on an unknown agent', async () => {
        const res = await chat('ghost', { message: 'hi' })
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'agent not found' })
    })

    it('refuses an agent that is switched off', async () => {
        const res = await chat('sleepy', { message: 'hi' })
        expect(res.status).toBe(403)
        expect(state.calls).toHaveLength(0)
    })

    it('rejects a body without a message', async () => {
        const res = await chat(id, { message: '' })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toMatch(/^message: /)
    })

    it('404s on a session the agent does not have', async () => {
        const res = await chat(id, { sessionId: 'nope', message: 'hi' })
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'session not found for this agent' })
    })

    it('opens a dashboard session, streams the run and names both in the headers', async () => {
        const res = await chat(id, { message: 'hello' })
        expect(res.status).toBe(200)
        const sessionId = res.headers.get('x-session-id')!
        const runId = res.headers.get('x-run-id')!
        expect(await res.text()).toContain('hello from the mock')

        expect((await getSession(id, sessionId))?.source).toBe('dashboard')
        expect(await getRun(id, runId)).toMatchObject({ agentId: id, sessionId, status: 'running' })
        expect(state.calls).toEqual([expect.objectContaining({ sessionId, message: 'hello', runId, override: { connectionId: undefined, provider: undefined, model: undefined } })])
    })

    it('records the source the caller named', async () => {
        const res = await chat(id, { message: 'from the api', source: 'api' })
        await res.text()
        expect((await getSession(id, res.headers.get('x-session-id')!))?.source).toBe('api')
    })

    it('continues an existing session and forwards the model override', async () => {
        const session = await createSession(id, 'ongoing')
        const res = await chat(id, { sessionId: session.id, message: 'again', connectionId: 'cnx', provider: 'anthropic', model: 'claude-sonnet-4-6' })
        await res.text()
        expect(res.headers.get('x-session-id')).toBe(session.id)
        expect(state.calls[0].override).toEqual({ connectionId: 'cnx', provider: 'anthropic', model: 'claude-sonnet-4-6' })
    })

    it('hands the brief to a foreman agent only', async () => {
        const brief = { instructions: 'Interview the user.', tools: [] }
        await (await chat('boss', { message: 'hi', foreman: brief })).text()
        expect(state.calls[0].agent.brief).toEqual(brief)

        await (await chat(id, { message: 'hi', foreman: brief })).text()
        expect(state.calls[1].agent.brief).toBeUndefined()
    })

    it('frees the session when the run row cannot be written', async () => {
        const session = await createSession(id, 'start fails')
        state.startRunError = new Error('disk is full')
        const res = await chat(id, { sessionId: session.id, message: 'hi' })
        expect(res.status).toBe(500)
        expect(state.calls).toHaveLength(0)
        expect(claimSession(session.id, 'next')).toBeNull()
        releaseSession('next')
    })

    it('frees the session when the run loop throws before it starts', async () => {
        const session = await createSession(id, 'run fails')
        state.runAgentError = new Error('no model available')
        const res = await chat(id, { sessionId: session.id, message: 'hi' })
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('no model available')
        expect(claimSession(session.id, 'next')).toBeNull()
        releaseSession('next')
        expect(sessionClaimCount()).toBe(0)
    })

    it('runs one install per agent and points a second start at the conversation already running it', async () => {
        const first = await chat('installer', { message: 'install', install: true })
        expect(first.status).toBe(200)
        await first.text()
        const sessionId = first.headers.get('x-session-id')

        const second = await chat('installer', { message: 'install', install: true })
        expect(second.status).toBe(409)
        expect(await second.json()).toMatchObject({ code: 'install_in_flight', sessionId })
        expect(state.calls).toHaveLength(1)

        const other = await chat('installer', { message: 'something else' })
        expect(other.status).toBe(200)
        expect(other.headers.get('x-session-id')).not.toBe(sessionId)
    })

    it('hands the language of the user to the run that starts an install, and to no other', async () => {
        await seed('greeter', { name: 'greeter', setup: { required: true } })
        await writeFile(installPath('greeter'), 'Say hello.\n', 'utf8')

        await (await chat('greeter', { message: 'install', install: true, userLanguage: 'French' })).text()
        await (await chat(id, { message: 'hi', userLanguage: 'French' })).text()

        expect(state.calls.map(call => call.trigger?.userLanguage)).toEqual(['French', undefined])
    })
})

describe('desktop Regenerate reply', () => {
    const attachment = { path: 'agenda.md', content: 'Original file contents.' }

    async function history() {
        const { workspaceAttachmentPart, contextTextPart } = await import('@rerun/contracts')
        const { appendMessage } = await import('../../db/repos/messages.js')
        const session = await createSession(id)
        const first = await appendMessage(id, session.id, { role: 'user', content: 'hello' })
        await appendMessage(id, session.id, { role: 'assistant', content: 'first answer' })
        const user = await appendMessage(id, session.id, { role: 'user', content: [
            { type: 'text', text: 'Review the agenda' }, workspaceAttachmentPart(attachment), contextTextPart('original recall and time'),
        ] }, { id: 'local', name: 'Local User' })
        const answer = await appendMessage(id, session.id, { role: 'assistant', content: 'old draft' })
        await appendMessage(id, session.id, { role: 'user', content: 'later question' })
        await appendMessage(id, session.id, { role: 'assistant', content: 'later answer' })
        return { first, user, answer, session, body: { sessionId: session.id, regenerateMessageId: answer.id, requestId: crypto.randomUUID(), source: 'dashboard' } }
    }

    it('branches an older saved answer exactly once, with an identical saved user payload and no later rows or copied run', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { listMessages } = await import('../../db/repos/messages.js')
            const { listRunsByAgent } = await import('../../db/repos/runs.js')
            const { session, body, user, first } = await history()
            const original = await listMessages(id, session.id)
            const responses = await Promise.all([chat(id, body), chat(id, body)])
            const fork = responses[0].headers.get('x-session-id')!
            const runId = responses[0].headers.get('x-run-id')
            expect(fork).toBeTruthy()
            expect(fork).not.toBe(session.id)
            for (const res of responses) {
                expect([200, 204]).toContain(res.status)
                expect(res.headers.get('x-session-id')).toBe(fork)
                expect(res.headers.get('x-run-id')).toBe(runId)
                await res.text()
            }
            expect(state.calls).toHaveLength(1)
            const copied = await listMessages(id, fork)
            expect(copied.map(row => row.contentJson)).toEqual(original.slice(0, 3).map(row => row.contentJson))
            expect(copied.every(row => !original.some(source => source.id === row.id))).toBe(true)
            expect(state.calls[0]).toMatchObject({ sessionId: fork, message: 'Review the agenda', trigger: { savedUser: { id: copied[2].id, contentJson: user.contentJson, authorId: 'local' } } })
            expect(await listMessages(id, session.id)).toEqual(original)
            expect(await listRunsByAgent(id, { sessionId: fork })).toHaveLength(1)
            expect((await chat(id, { ...body, regenerateMessageId: first.id })).status).toBe(409)
        } finally { vi.unstubAllEnvs() }
    })

    it('regeneration receipt probes never start work and recover only the exact accepted source', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { listSessions } = await import('../../db/repos/sessions.js')
            const { body, first } = await history()
            const before = await listSessions(id)
            const missing = await chat(id, { ...body, replayOnly: true, connectionId: 'unavailable-connection' })
            expect(missing.status).toBe(404)
            expect(await missing.json()).toEqual({ code: 'regeneration_not_found' })
            expect(await listSessions(id)).toEqual(before)
            expect(state.calls).toHaveLength(0)
            const accepted = await chat(id, body)
            await accepted.text()
            expect(state.calls).toHaveLength(1)
            const replay = await chat(id, { ...body, replayOnly: true, connectionId: 'unavailable-connection' })
            expect([200, 204]).toContain(replay.status)
            expect(replay.headers.get('x-session-id')).toBe(accepted.headers.get('x-session-id'))
            expect(replay.headers.get('x-run-id')).toBe(accepted.headers.get('x-run-id'))
            await replay.text()
            expect(state.calls).toHaveLength(1)
            expect((await chat(id, { ...body, replayOnly: true, regenerateMessageId: first.id })).status).toBe(409)
            expect(state.calls).toHaveLength(1)
        } finally { vi.unstubAllEnvs() }
    })

    it('rejects unowned, non-assistant, forged, and busy targets before creating any session', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { listSessions } = await import('../../db/repos/sessions.js')
            const { body, session, first } = await history()
            const before = await listSessions(id)
            expect((await chat('boss', body)).status).toBe(404)
            expect((await chat(id, { ...body, regenerateMessageId: 'foreign' })).status).toBe(404)
            expect((await chat(id, { ...body, regenerateMessageId: first.id })).status).toBe(409)
            expect((await chat(id, { ...body, workspaceAttachment: attachment })).status).toBe(400)
            expect((await chat(id, { ...body, message: 'different question' })).status).toBe(400)
            claimSession(session.id, 'busy')
            try { expect((await chat(id, body)).status).toBe(409) } finally { releaseSession('busy') }
            expect(await listSessions(id)).toEqual(before)
            expect(state.calls).toHaveLength(0)
        } finally { vi.unstubAllEnvs() }
    })

    it('rejects cancelled partial answers and hidden-only reasoning, but accepts a legacy {text} reply', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { getSystemDb } = await import('../../db/systemDb.js')
            const { session, body, answer, user } = await history()
            const { client } = await getSystemDb(id)
            await client.execute({
                sql: 'INSERT INTO runs (id,agent_id,session_id,status,started_at,finished_at) VALUES (?,?,?,?,?,?)',
                args: ['cancelled-partial', id, session.id, 'cancelled', answer.createdAt, answer.createdAt],
            })
            expect((await chat(id, body)).status).toBe(409)
            await client.execute("DELETE FROM runs WHERE id = 'cancelled-partial'")
            await client.execute({ sql: 'UPDATE messages SET content_json = ? WHERE id = ?', args: ['{"type":"reasoning","text":"private"}', answer.id] })
            expect((await chat(id, body)).status).toBe(409)
            await client.execute({ sql: 'UPDATE messages SET content_json = ? WHERE id = ?', args: ['{"text":"old answer"}', answer.id] })
            await client.execute({ sql: 'UPDATE messages SET content_json = ? WHERE id = ?', args: ['{"text":"old question"}', user.id] })
            const res = await chat(id, body)
            expect(res.status).toBe(200)
            await res.text()
            expect(state.calls).toMatchObject([{ message: 'old question' }])
        } finally { vi.unstubAllEnvs() }
    })

    it('rolls back a failed prefix copy, retries cleanly and reopens an accepted request without a buffered stream', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { getSystemDb } = await import('../../db/systemDb.js')
            const { forkReply } = await import('../../db/repos/regenerations.js')
            const { listSessions } = await import('../../db/repos/sessions.js')
            const { listMessages } = await import('../../db/repos/messages.js')
            const { session, body } = await history()
            const rows = await listMessages(id, session.id)
            const before = await listSessions(id)
            const { client } = await getSystemDb(id)
            await client.execute("CREATE TRIGGER fail_clone BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
            try { await expect(forkReply(id, session, body)).rejects.toThrow('injected write failure') }
            finally { await client.execute('DROP TRIGGER fail_clone') }
            expect(await listSessions(id)).toEqual(before)
            expect(await listMessages(id, session.id)).toEqual(rows)
            const accepted = await forkReply(id, session, body)
            const res = await chat(id, body)
            expect(res.status).toBe(204)
            expect(res.headers.get('x-session-id')).toBe(accepted.sessionId)
            expect(res.headers.get('x-run-id')).toBe(accepted.runId)
            expect(state.calls).toHaveLength(0)
        } finally { vi.unstubAllEnvs() }
    })
})


describe('desktop credential follow-ups', () => {
    const owner = 'credential-agent'
    const fields = [{ key: 'EXAMPLE_API_KEY', label: 'Example key' }]
    async function pendingSecret(status = 'done') {
        const { appendMessage } = await import('../../db/repos/messages.js')
        const { getSystemDb } = await import('../../db/systemDb.js')
        const { findDesktopSecretRequest } = await import('@rerun/contracts')
        await seed(owner, { name: 'Credential fixture', tools: { desktopToolGrants: { requestSecret: true } } })
        const session = await createSession(owner)
        const runId = crypto.randomUUID(), callId = crypto.randomUUID()
        const input = { secrets: fields }
        const call = await appendMessage(owner, session.id, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: 'request_secret', input }] })
        const result = await appendMessage(owner, session.id, { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'request_secret', output: { type: 'json', value: { status: 'delivered' } } }] })
        const { client } = await getSystemDb(owner)
        const now = new Date().toISOString()
        await client.execute({ sql: 'INSERT INTO runs (id,agent_id,session_id,status,started_at) VALUES(?,?,?,?,?)', args: [runId, owner, session.id, status, now] })
        await client.execute({ sql: 'INSERT INTO tool_calls (id,run_id,agent_id,session_id,step_number,tool_call_id,tool_name,input_json,result_json,is_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', args: [crypto.randomUUID(), runId, owner, session.id, 1, callId, 'request_secret', JSON.stringify(input), JSON.stringify({ status: 'delivered' }), 0, now] })
        const found = findDesktopSecretRequest([call, result])!
        return { session, secret: { runId, sourceMessageId: found.sourceMessageId, toolCallId: found.toolCallId, fingerprint: found.fingerprint } }
    }
    it('blocks ordinary queued sends while credentials are pending and replays the exact accepted metadata result after disable', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { serializeDesktopSecretReceiptSummary } = await import('@rerun/contracts')
            const { listMessages } = await import('../../db/repos/messages.js')
            const { session, secret } = await pendingSecret()
            expect((await chat(owner, { sessionId: session.id, message: 'Ignore the form' })).status).toBe(409)
            expect((await chat(owner, { sessionId: session.id, message: 'Queued', desktopQueuedTurn: { runId: crypto.randomUUID() } })).status).toBe(409)
            const input = { sessionId: session.id, message: serializeDesktopSecretReceiptSummary(fields, ['EXAMPLE_API_KEY'], 'save'), desktopQueuedTurn: { runId: crypto.randomUUID(), secret } }
            const accepted = await chat(owner, input)
            expect(accepted.status).toBe(200); await accepted.text()
            await seed(owner, { name: 'Credential fixture', enabled: false })
            const replay = await chat(owner, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, replayOnly: true } })
            expect([200, 204]).toContain(replay.status)
            expect(replay.headers.get('x-run-id')).toBe(input.desktopQueuedTurn.runId)
            expect((await listMessages(owner, session.id)).filter(row => row.role === 'user')).toHaveLength(1)
            expect((await chat(owner, { ...input, desktopQueuedTurn: { ...input.desktopQueuedTurn, secret: { ...secret, runId: 'other-run' }, replayOnly: true } })).status).toBe(409)
        } finally { vi.unstubAllEnvs() }
    })
    it('rejects source run substitution and non-metadata credential follow-ups before reserving any turn', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { session, secret } = await pendingSecret()
            const runId = crypto.randomUUID()
            const input = { sessionId: session.id, message: 'private-value-must-not-be-admitted', desktopQueuedTurn: { runId, secret } }
            expect((await chat(owner, input)).status).toBe(400)
            expect(await getRun(owner, runId)).toBeUndefined()
            expect((await chat(owner, { ...input, desktopQueuedTurn: { runId, secret: { ...secret, runId: 'foreign-run' } } })).status).toBe(409)
            expect((await chat(owner, { ...input, desktopQueuedTurn: { runId, secret, question: { sourceMessageId: secret.sourceMessageId, toolCallId: secret.toolCallId, fingerprint: secret.fingerprint } } })).status).toBe(400)
        } finally { vi.unstubAllEnvs() }
    })
    it('a stopped source cannot accept a credential result or keep ordinary chat blocked', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            const { serializeDesktopSecretReceiptSummary } = await import('@rerun/contracts')
            const { session, secret } = await pendingSecret('cancelled')
            expect((await chat(owner, { sessionId: session.id, message: serializeDesktopSecretReceiptSummary(fields, [], 'skip'), desktopQueuedTurn: { runId: crypto.randomUUID(), secret } })).status).toBe(409)
            const normal = await chat(owner, { sessionId: session.id, message: 'Continue after Stop' })
            expect(normal.status).toBe(200); await normal.text()
        } finally { vi.unstubAllEnvs() }
    })
})

describe('desktop MCP sign-in follow-up admission', () => {
    it('admits the exact canonical queued result, blocks ordinary messages, and replays after disable', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP','1')
        try {
            const owner='mcp-signin-queue'
            await seed(owner,{name:'MCP sign-in',tools:{desktopToolGrants:{mcp:true}}})
            const {appendMessage,listMessages}=await import('../../db/repos/messages.js')
            const {getSystemDb}=await import('../../db/systemDb.js')
            const {readDesktopMcpSignInSource}=await import('../../desktop/mcp-sign-in/source.js')
            const {serializeDesktopMcpSignInResult}=await import('@rerun/contracts')
            const session=await createSession(owner),runId=crypto.randomUUID(),callId=crypto.randomUUID(),now=new Date().toISOString()
            const input={name:'linear'},server={name:'linear',revision:'revision',url:'https://linear.example/mcp',displayName:'Linear',host:'linear.example',icon:null}
            const output={status:'delivered',server}
            await appendMessage(owner,session.id,{role:'assistant',content:[{type:'tool-call',toolCallId:callId,toolName:'request_mcp_sign_in',input}]})
            await appendMessage(owner,session.id,{role:'tool',content:[{type:'tool-result',toolCallId:callId,toolName:'request_mcp_sign_in',output:{type:'json',value:output}}]})
            const {client}=await getSystemDb(owner)
            await client.execute({sql:'INSERT INTO runs(id,agent_id,session_id,status,started_at) VALUES(?,?,?,?,?)',args:[runId,owner,session.id,'done',now]})
            await client.execute({sql:'INSERT INTO tool_calls(id,run_id,agent_id,session_id,step_number,tool_call_id,tool_name,input_json,result_json,is_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:[crypto.randomUUID(),runId,owner,session.id,1,callId,'request_mcp_sign_in',JSON.stringify(input),JSON.stringify(output),0,now]})
            const source=await readDesktopMcpSignInSource(owner,session.id)
            expect(source).not.toBeNull()
            expect((await chat(owner,{sessionId:session.id,message:'Ignore sign-in',desktopQueuedTurn:{runId:crypto.randomUUID()}})).status).toBe(409)
            const request={sessionId:session.id,message:serializeDesktopMcpSignInResult('linear','declined'),desktopQueuedTurn:{runId:crypto.randomUUID(),mcpSignIn:source!.guard}}
            const accepted=await chat(owner,request);expect(accepted.status).toBe(200);await accepted.text()
            await seed(owner,{name:'MCP sign-in',enabled:false})
            const replay=await chat(owner,{...request,desktopQueuedTurn:{...request.desktopQueuedTurn,replayOnly:true}})
            expect([200,204]).toContain(replay.status)
            expect((await listMessages(owner,session.id)).filter(row=>row.role==='user')).toHaveLength(1)
            expect((await chat(owner,{...request,desktopQueuedTurn:{...request.desktopQueuedTurn,replayOnly:true,mcpSignIn:{...source!.guard,runId:'foreign'}}})).status).toBe(409)
        } finally {vi.unstubAllEnvs()}
    })
})
