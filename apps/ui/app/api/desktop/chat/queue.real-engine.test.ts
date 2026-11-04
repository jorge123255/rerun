import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { GET as readQueue, PUT as writeQueue } from '../agents/[agentId]/queue/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { createAgent, createConnection, setBoxDefault } from '@/lib/engine/client'
import type { DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { POST as chat } from './route'

test.runIf(process.env.RERUN_QUEUE_ACCEPTANCE === '1')('queued sends keep exact chat/model/file bytes and reconcile one accepted run after a cold restart and lost acknowledgement', async () => {
    const env = { ...process.env }, root = await mkdtemp(join(tmpdir(), 'rerun-queued-acceptance-'))
    const engine = await disposableRunEngine(root)
    function request(path: string, method = 'GET', body?: object) {
        const { origin, sessionToken } = engine.runtime.app
        return new Request(origin + path, { method, headers: { host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + sessionToken, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    }
    const send = (body: object) => chat(request('/api/desktop/chat', 'POST', body))
    async function seedChat(body: object, number: number) {
        const response = await send(body)
        expect(response.status).toBe(200)
        const stream = response.text()
        await engine.waitForProviderRequest(number); engine.finishReply(); await stream
        return { id: response.headers.get('x-session-id')!, runId: response.headers.get('x-run-id')! }
    }
    try {
        const runtime = await engine.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Local queue fixture', provider: 'openrouter', models: ['qa-local', 'qa-other'], extraModels: [], baseUrl: engine.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const engineAgent = await createAgent(conn, { config: { name: 'queue-worker', connectionId: provider.id, provider: 'openrouter', tools: { memory: false }, selfImprovement: { enabled: false } } })
        const db = await openDesktopDatabase(root)
        const agent = await createDesktopAgent(db, { name: 'Queue worker', engineAgentId: engineAgent.id })
        const other = await createDesktopAgent(db, { name: 'Other owner', engineAgentId: 'other-owner' })
        const a = await seedChat({ agentId: agent.id, text: 'First chat seed', modelChoice: { connectionId: provider.id, model: 'qa-other' } }, 1)
        const b = await seedChat({ agentId: agent.id, text: 'Second chat seed' }, 2)
        const context = { params: Promise.resolve({ agentId: agent.id }) }, path = '/api/desktop/agents/' + agent.id + '/queue'
        const file = join(root, 'workspaces/1/engine/agents', engineAgent.id, 'workspace', 'reference.md')
        await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'The queue reference is cobalt-8341.')
        const first: DesktopQueuedMessage = { id: crypto.randomUUID(), text: 'Read my queued reference', attachmentPath: 'reference.md', createdAt: Date.now(), behindRunId: a.runId, state: 'waiting' }
        const second: DesktopQueuedMessage = { id: crypto.randomUUID(), text: 'Keep this in the second chat', createdAt: Date.now(), behindRunId: b.runId, state: 'waiting' }
        for (const [sessionId, item] of [[a.id, first], [b.id, second]] as const) {
            expect((await writeQueue(request(path, 'PUT', { action: 'enqueue', scope: { sessionId }, expectedId: null, item }), context)).status).toBe(200)
        }
        expect((await writeQueue(request(path, 'PUT', { action: 'attempt', scope: { sessionId: a.id }, id: first.id }), context)).status).toBe(200)
        const body = { agentId: agent.id, sessionId: a.id, text: first.text, requestId: first.id, attachmentPath: first.attachmentPath }
        // Two clients lose their acknowledgement; both use the durable UUID still held in SQLite.
        const accepted = await Promise.all([send(body), send(body)])
        for (const response of accepted) { expect(response.status).toBe(200); expect(response.headers.get('x-run-id')).toBe(first.id) }
        const streams = accepted.map(response => response.text())
        await engine.waitForProviderRequest(3); engine.finishReply(); await Promise.all(streams)
        expect(engine.providerMessages).toHaveLength(3)
        expect(engine.providerModels).toEqual(['qa-other', 'qa-local', 'qa-other'])
        const providerText = JSON.stringify(engine.providerMessages[2])
        expect(providerText.match(/Read my queued reference/g)).toHaveLength(1)
        expect(providerText).toContain('cobalt-8341')
        expect(providerText).not.toContain(second.text)
        const before = await readDesktopHistory(engine.runtime, a.id)
        expect(before.filter(message => message.role === 'user')).toHaveLength(2)
        expect(JSON.stringify(before)).not.toContain('cobalt-8341')
        await rm(file)
        await closeDesktopDatabase(root); await engine.stop(); await engine.start()
        // A different loopback origin after restart cannot affect the SQLite queue.
        engine.runtime.app.origin = 'http://127.0.0.1:3190'
        await writeFile(join(root, 'runtime.json'), JSON.stringify(engine.runtime), { mode: 0o600 })
        const restoredA = await readQueue(request(path + '?sessionId=' + a.id), context)
        expect((await restoredA.json()).queued).toMatchObject({ ...first, state: 'sending' })
        expect((await (await readQueue(request(path + '?sessionId=' + b.id), context)).json()).queued).toEqual(second)
        expect(await readDesktopHistory(engine.runtime, a.id)).toEqual(before)
        const replay = await send({ ...body, reconcileOnly: true })
        expect(replay.status).toBe(200); expect(replay.headers.get('x-run-id')).toBe(first.id); await replay.text()
        expect(engine.providerMessages).toHaveLength(3)
        expect((await send({ ...body, sessionId: b.id })).status).toBe(409)
        expect((await send({ ...body, agentId: other.id })).status).toBe(404)
        expect((await writeQueue(request(path, 'PUT', { action: 'remove', scope: { sessionId: a.id }, id: first.id }), context)).status).toBe(200)
        expect((await (await readQueue(request(path + '?sessionId=' + a.id), context)).json()).queued).toBeNull()
        expect((await (await readQueue(request(path + '?sessionId=' + b.id), context)).json()).queued).toEqual(second)
        expect(engine.providerMessages).toHaveLength(3)
    } finally {
        await closeDesktopDatabase(root); await engine.close(); process.env = env; await rm(root, { recursive: true, force: true })
    }
}, 60000)
