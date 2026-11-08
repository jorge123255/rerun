import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { serializeApprovalDecisions } from '@rerun/contracts'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { POST as triggerCallback } from '@/app/api/desktop/internal/triggers/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, findDesktopSession, setDesktopSessionModel } from '@/lib/desktop/server/store'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { createAgent, createConnection, getAgent, listRuns, patchAgent, setBoxDefault } from '@/lib/engine/client'
import type { DesktopPendingApproval, DesktopApprovalAnswer } from '@/lib/desktop/approvals'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { GET, POST } from './route'

test.runIf(process.env.RERUN_APPROVAL_ACCEPTANCE === '1')('a real approval survives restart, sends only canonical mixed decisions once after a lost acknowledgement, and preserves later approvals and another chat', async () => {
    const env = { ...process.env }, root = await mkdtemp(join(tmpdir(), 'rerun-approval-acceptance-'))
    const approvals = [
        { action: 'Prepare a local draft', detail: 'Keep the result in this chat.' },
        { action: 'Send it externally', detail: 'An external action requires a separate decision.' },
        { action: 'Delete the source file' },
    ]
    const decisions: DesktopApprovalAnswer['decisions'] = [{ decision: 'approved' }, { decision: 'declined', note: 'Keep it local.' }, { decision: 'declined' }]
    const engine = await disposableRunEngine(root, undefined, {
        triggerCallback,
        replyForRequest: index => index === 1 ? 'Please review these actions before I continue.' : index === 3 ? 'I recorded your decisions. One separate approval remains.' : 'A completed local run.',
        toolCallsForRequest: index => index === 1 ? [{ id: 'approval-call', name: 'request_approval', input: { approvals } }]
            : index === 3 ? [{ id: 'approval-call', name: 'request_approval', input: { approvals: [{ action: 'Prepare a separate summary', detail: 'This is a later approval batch.' }] } }] : [],
    })
    function request(path: string, method = 'GET', body?: object) {
        const { origin, sessionToken } = engine.runtime.app
        return new Request(origin + path, { method, headers: { host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + sessionToken, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    }
    const path = (sessionId: string) => '/api/desktop/sessions/' + sessionId + '/approvals'
    const pending = async (sessionId: string): Promise<DesktopPendingApproval | null> => {
        const response = await GET(request(path(sessionId)), { params: Promise.resolve({ sessionId }) })
        expect(response.status).toBe(200)
        return (await response.json()).approval
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
        const provider = await createConnection(conn(), { name: 'Approval fixture', provider: 'openrouter', models: ['qa-local', 'qa-chat'], extraModels: [], baseUrl: engine.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn(), { connectionId: provider.id, model: 'qa-local' })
        const engineAgent = await createAgent(conn(), { config: { name: 'approval-worker', connectionId: provider.id, provider: 'openrouter',
            tools: { memory: false, desktopToolGrants: { requestApproval: true } }, selfImprovement: { enabled: false } } })
        const agent = await createDesktopAgent(await openDesktopDatabase(root), { name: 'Approval worker', engineAgentId: engineAgent.id })
        const originalTools = (await getAgent(conn(), engineAgent.id)).config.tools
        const sessionId = await firstTurn({ agentId: agent.id, text: 'Request a decision for each proposed action.', modelChoice: { connectionId: provider.id, model: 'qa-chat' } }, 1)
        expect(engine.providerTools[0].some((tool: { function?: { name?: string } }) => tool.function?.name === 'request_approval')).toBe(true)
        const original = await pending(sessionId)
        expect(original?.approvals).toEqual(approvals)
        const otherSession = await firstTurn({ agentId: agent.id, text: 'Keep this other chat separate.' }, 2)
        const otherHistory = await readDesktopHistory(engine.runtime, otherSession)
        expect(await pending(otherSession)).toBeNull()
        const requestId = crypto.randomUUID()
        const payload = { approvalId: original!.id, requestId, decisions }
        // Save a valid intent while its pinned model is unavailable, then cold-start both layers.
        await setDesktopSessionModel(await openDesktopDatabase(root), sessionId, { connectionId: provider.id, model: 'not-offered' })
        const unavailableModel = await answer(sessionId, payload)
        expect(unavailableModel.status).toBe(409)
        expect(await unavailableModel.json()).toEqual({ error: 'This conversation’s model is no longer available. Choose another model or follow the coworker default.' })
        expect(engine.providerMessages).toHaveLength(2)
        await restart()
        const restored = await pending(sessionId)
        expect(restored?.id).toBe(original!.id)
        expect(restored?.attempt).toEqual({ requestId, decisions })
        const db = await openDesktopDatabase(root)
        await setDesktopSessionModel(db, sessionId, { connectionId: provider.id, model: 'qa-chat' })
        await db.execute("CREATE TRIGGER lose_approval_acceptance BEFORE UPDATE OF accepted ON desktop_approval_answers BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END")
        // Genuine engine acceptance persists the run/user row before the app loses its receipt ACK.
        expect((await answer(sessionId, { ...payload, requestId: crypto.randomUUID() })).status).toBe(500)
        await engine.waitForProviderRequest(3); engine.finishReply()
        const session = await findDesktopSession(db, sessionId)
        await expect.poll(async () => (await listRuns(conn(), engineAgent.id, { sessionId: session!.engineSessionId })).find(run => run.id === requestId)?.status).toBe('done')
        await db.execute('DROP TRIGGER lose_approval_acceptance')
        const later = await pending(sessionId)
        expect(later?.id).not.toBe(original!.id)
        expect(later?.approvals[0].action).toBe('Prepare a separate summary')
        const serialized = serializeApprovalDecisions(approvals.map((item, index) => ({ ...item, ...decisions[index] })))
        const providerInput = JSON.stringify(engine.providerMessages[2])
        expect(providerInput).toContain(JSON.stringify(serialized).slice(1, -1))
        expect(providerInput.match(/Here are my approval decisions:/g)).toHaveLength(1)
        expect(engine.providerModels).toEqual(['qa-chat', 'qa-local', 'qa-chat'])
        expect((await getAgent(conn(), engineAgent.id)).config.tools).toEqual(originalTools)
        await restart()
        await patchAgent(conn(), engineAgent.id, { enabled: false })
        await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [agent.id] })
        const replay = await answer(sessionId, { ...payload, requestId: crypto.randomUUID() })
        expect(replay.status).toBe(200); expect(replay.headers.get('x-run-id')).toBe(requestId); expect(replay.headers.get('x-approval-id')).toBe(original!.id); await replay.text()
        expect(engine.providerMessages).toHaveLength(3)
        expect((await pending(sessionId))?.id).toBe(later!.id)
        expect(await readDesktopHistory(engine.runtime, otherSession)).toEqual(otherHistory)
        expect((await answer(otherSession, payload)).status).toBe(409)
        expect((await answer(sessionId, { ...payload, decisions: approvals.map(() => ({ decision: 'approved' })) })).status).toBe(409)
        await patchAgent(conn(), engineAgent.id, { enabled: true })
        await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agents SET enabled = 1 WHERE id = ?', args: [agent.id] })
        const declined = await answer(sessionId, { approvalId: later!.id, requestId: crypto.randomUUID(), decisions: [{ decision: 'declined', note: 'No further action.' }] })
        expect(declined.status).toBe(200)
        const finalStream = declined.text()
        await engine.waitForProviderRequest(4); engine.finishReply(); await finalStream
        const finalText = serializeApprovalDecisions([{ ...later!.approvals[0], decision: 'declined', note: 'No further action.' }])
        expect(JSON.stringify(engine.providerMessages[3])).toContain(JSON.stringify(finalText).slice(1, -1))
        expect(await pending(sessionId)).toBeNull()
        expect(engine.providerMessages).toHaveLength(4)
        expect((await getAgent(conn(), engineAgent.id)).config.tools).toEqual(originalTools)
        expect(await readDesktopHistory(engine.runtime, otherSession)).toEqual(otherHistory)
    } finally {
        await closeDesktopDatabase(root); await engine.close(); process.env = env; await rm(root, { recursive: true, force: true })
    }
}, 90000)
