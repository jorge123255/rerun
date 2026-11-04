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
            expect(await getRun(id, first.runId)).toMatchObject({ sessionId: first.sessionId })
            expect((await chat(id, { ...input, desktopFirstTurn: { ...first, runId: crypto.randomUUID() } })).status).toBe(409)
            expect((await chat(id, { ...input, sessionId: first.sessionId })).status).toBe(400)
            expect(state.calls).toHaveLength(1)
        } finally { vi.unstubAllEnvs() }
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
