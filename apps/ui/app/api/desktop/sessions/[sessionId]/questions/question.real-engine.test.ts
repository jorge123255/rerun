import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { HITL_CANCELLED, serializeAnswers } from '@rerun/contracts'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { POST as triggerCallback } from '@/app/api/desktop/internal/triggers/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, findDesktopSession, setDesktopSessionModel } from '@/lib/desktop/server/store'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { createAgent, createConnection, listRuns, patchAgent, setBoxDefault } from '@/lib/engine/client'
import type { DesktopPendingQuestion } from '@/lib/desktop/questions'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { GET, POST } from './route'

test.runIf(process.env.RERUN_QUESTION_ACCEPTANCE === '1')('a real ask_user turn persists, resumes one canonical answer after a lost acknowledgement, and keeps a later question and another chat separate', async () => {
    const env = { ...process.env }, root = await mkdtemp(join(tmpdir(), 'rerun-question-acceptance-'))
    const questions = [
        { question: 'What name should I use?' },
        { question: 'Which color?', options: ['Blue', 'Green'] },
        { question: 'Which channels?', options: ['Email', 'Chat'], multiple: true },
        { question: 'Any extra detail?' },
    ]
    const answers = [['Rerun Mac'], ['Blue'], ['Email', 'Chat', 'Custom channel'], []]
    const engine = await disposableRunEngine(root, undefined, {
        triggerCallback,
        replyForRequest: index => index === 1 ? 'I need your preferences before continuing.' : index === 3 ? 'I saved those preferences. One more question.' : 'A completed local run.',
        toolCallsForRequest: index => index === 1 ? [{ id: 'question-call', name: 'ask_user', input: { questions } }]
            : index === 3 ? [{ id: 'question-call', name: 'ask_user', input: { questions: [{ question: 'Which output format?', options: ['Text', 'Markdown'] }] } }] : [],
    })
    function request(path: string, method = 'GET', body?: object) {
        const { origin, sessionToken } = engine.runtime.app
        return new Request(origin + path, { method, headers: { host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + sessionToken, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    }
    const path = (sessionId: string) => '/api/desktop/sessions/' + sessionId + '/questions'
    const pending = async (sessionId: string): Promise<DesktopPendingQuestion | null> => {
        const response = await GET(request(path(sessionId)), { params: Promise.resolve({ sessionId }) })
        expect(response.status).toBe(200)
        return (await response.json()).question
    }
    const answer = (sessionId: string, body: object) => POST(request(path(sessionId), 'POST', body), { params: Promise.resolve({ sessionId }) })
    const conn = () => ({ baseUrl: engine.runtime.engine.origin, apiKey: engine.runtime.engine.apiKey })
    async function firstTurn(body: object, number: number) {
        const response = await chat(request('/api/desktop/chat', 'POST', body))
        expect(response.status).toBe(200)
        const stream = response.text()
        await engine.waitForProviderRequest(number); engine.finishReply(); await stream
        return response.headers.get('x-session-id')!
    }
    async function restart() {
        await closeDesktopDatabase(root)
        await engine.stop()
        await engine.start()
    }
    try {
        await engine.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const provider = await createConnection(conn(), { name: 'Question fixture', provider: 'openrouter', models: ['qa-local', 'qa-chat'], extraModels: [], baseUrl: engine.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn(), { connectionId: provider.id, model: 'qa-local' })
        const engineAgent = await createAgent(conn(), { config: { name: 'question-worker', connectionId: provider.id, provider: 'openrouter',
            tools: { memory: false, desktopToolGrants: { askUser: true } }, selfImprovement: { enabled: false } } })
        const agent = await createDesktopAgent(await openDesktopDatabase(root), { name: 'Question worker', engineAgentId: engineAgent.id })
        const sessionId = await firstTurn({ agentId: agent.id, text: 'Ask me the required preferences.', modelChoice: { connectionId: provider.id, model: 'qa-chat' } }, 1)
        expect(engine.providerTools[0].some((tool: { function?: { name?: string } }) => tool.function?.name === 'ask_user')).toBe(true)
        const original = await pending(sessionId)
        expect(original?.questions.map(item => item.question)).toEqual(questions.map(item => item.question))
        const otherSession = await firstTurn({ agentId: agent.id, text: 'Keep this second chat separate.' }, 2)
        const otherHistory = await readDesktopHistory(engine.runtime, otherSession)
        expect(await pending(otherSession)).toBeNull()
        const requestId = crypto.randomUUID()
        const payload = { questionId: original!.id, requestId, action: 'answer', answers }
        // A valid answer intent can outlive a temporarily unavailable conversation model.
        await setDesktopSessionModel(await openDesktopDatabase(root), sessionId, { connectionId: provider.id, model: 'not-offered' })
        const unavailableModel = await answer(sessionId, payload)
        expect(unavailableModel.status).toBe(409)
        expect(await unavailableModel.json()).toEqual({ error: 'This conversation’s model is no longer available. Choose another model or follow the coworker default.' })
        expect(engine.providerMessages).toHaveLength(2)
        await restart()
        const restored = await pending(sessionId)
        expect(restored?.id).toBe(original!.id)
        expect(restored?.attempt).toEqual({ requestId, action: 'answer', answers })
        const db = await openDesktopDatabase(root)
        await setDesktopSessionModel(db, sessionId, { connectionId: provider.id, model: 'qa-chat' })
        await db.execute("CREATE TRIGGER lose_question_acceptance BEFORE UPDATE OF accepted ON desktop_question_answers BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END")
        // The real engine accepts the canonical run and persists its user answer. The app's
        // acceptance write fails, leaving the durable intent for reconciliation after restart.
        expect((await answer(sessionId, { ...payload, requestId: crypto.randomUUID() })).status).toBe(500)
        await engine.waitForProviderRequest(3); engine.finishReply()
        const session = await findDesktopSession(db, sessionId)
        await expect.poll(async () => (await listRuns(conn(), engineAgent.id, { sessionId: session!.engineSessionId })).find(run => run.id === requestId)?.status).toBe('done')
        await db.execute('DROP TRIGGER lose_question_acceptance')
        const later = await pending(sessionId)
        expect(later?.id).not.toBe(original!.id)
        expect(later?.questions[0].question).toBe('Which output format?')
        const serialized = serializeAnswers(questions.map((item, index) => ({ question: item.question, answers: answers[index] })))
        const providerInput = JSON.stringify(engine.providerMessages[2])
        expect(providerInput).toContain(JSON.stringify(serialized).slice(1, -1))
        expect(providerInput.match(/Here are my answers:/g)).toHaveLength(1)
        expect(engine.providerModels).toEqual(['qa-chat', 'qa-local', 'qa-chat'])
        await restart()
        await patchAgent(conn(), engineAgent.id, { enabled: false })
        await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [agent.id] })
        const replay = await answer(sessionId, { ...payload, requestId: crypto.randomUUID() })
        expect(replay.status).toBe(200); expect(replay.headers.get('x-run-id')).toBe(requestId); expect(replay.headers.get('x-question-id')).toBe(original!.id); await replay.text()
        expect(engine.providerMessages).toHaveLength(3)
        expect((await pending(sessionId))?.id).toBe(later!.id)
        expect(await readDesktopHistory(engine.runtime, otherSession)).toEqual(otherHistory)
        expect((await answer(otherSession, payload)).status).toBe(409)
        expect((await answer(sessionId, { ...payload, answers: [['Changed'], ['Blue'], [], []] })).status).toBe(409)
        await patchAgent(conn(), engineAgent.id, { enabled: true })
        await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agents SET enabled = 1 WHERE id = ?', args: [agent.id] })
        const cancelled = await answer(sessionId, { questionId: later!.id, requestId: crypto.randomUUID(), action: 'cancel' })
        expect(cancelled.status).toBe(200)
        const finalStream = cancelled.text()
        await engine.waitForProviderRequest(4); engine.finishReply(); await finalStream
        expect(JSON.stringify(engine.providerMessages[3])).toContain(HITL_CANCELLED.question)
        expect(await pending(sessionId)).toBeNull()
        expect(engine.providerMessages).toHaveLength(4)
    } finally {
        await closeDesktopDatabase(root); await engine.close(); process.env = env; await rm(root, { recursive: true, force: true })
    }
}, 90000)
