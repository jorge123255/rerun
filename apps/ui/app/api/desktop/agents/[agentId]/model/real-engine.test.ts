import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { GET as listRuns } from '@/app/api/desktop/agents/[agentId]/runs/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, findDesktopSession } from '@/lib/desktop/server/store'
import { createAgent, createConnection, listConnections, patchConnection, setBoxDefault } from '@/lib/engine/client'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { GET, PATCH } from './route'

test.runIf(process.env.RERUN_CHAT_MODEL_ACCEPTANCE === '1')('recorded runs use the chat, coworker, or workspace model and the saved choices survive restart', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-chat-model-engine-'))
    const fixture = await disposableRunEngine(root)
    let requests = 0
    const call = (path: string, method: string, body?: unknown) => new Request(`${fixture.runtime.app.origin}${path}`, {
        method, headers: { host: new URL(fixture.runtime.app.origin).host, origin: fixture.runtime.app.origin, cookie: `rerun-desktop-session=${fixture.runtime.app.sessionToken}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const list = async (agentId: string) => {
        const response = await listRuns(call(`/api/desktop/agents/${agentId}/runs`, 'GET'), { params: Promise.resolve({ agentId }) })
        expect(response.status).toBe(200)
        return (await response.json()).runs as Array<{ model: string | null; status: string; provider: string | null }>
    }
    const read = async (agentId: string, sessionId?: string) => {
        const response = await GET(call(`/api/desktop/agents/${agentId}/model${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, 'GET'), { params: Promise.resolve({ agentId }) })
        expect(response.status).toBe(200)
        return response.json()
    }
    const patch = async (agentId: string, body: unknown) => {
        const response = await PATCH(call(`/api/desktop/agents/${agentId}/model`, 'PATCH', body), { params: Promise.resolve({ agentId }) })
        expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
        return response.json()
    }
    async function say(agentId: string, text: string, model: string, sessionId?: string, modelChoice?: { connectionId: string; model: string }) {
        const response = await chat(call('/api/desktop/chat', 'POST', { agentId, text, ...(sessionId ? { sessionId } : {}), ...(modelChoice ? { modelChoice } : {}) }))
        if (response.status !== 200) throw new Error(`Chat failed ${response.status}: ${await response.text()}`)
        const streamed = response.text()
        const localSessionId = response.headers.get('x-session-id')
        await fixture.waitForProviderRequest(++requests)
        expect(fixture.providerModels[requests - 1]).toBe(model)
        fixture.finishReply()
        await streamed
        await vi.waitFor(async () => { expect((await list(agentId)).some(run => run.model === model && run.status === 'done')).toBe(true) })
        return localSessionId!
    }
    try {
        const runtime = await fixture.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const models = ['model-workspace', 'model-coworker', 'model-chat', 'model-bob']
        const provider = await createConnection(conn, { name: 'Disposable local provider', provider: 'openrouter', models, extraModels: [], baseUrl: fixture.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'model-workspace' })
        const config = { enabled: true, connectionId: provider.id, provider: 'openrouter' as const, selfImprovement: { enabled: false, autoMemory: false } }
        const first = await createAgent(conn, { config: { ...config, name: 'alice' } })
        const second = await createAgent(conn, { config: { ...config, name: 'bob' } })
        const db = await openDesktopDatabase(root)
        const alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: first.id })
        const bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: second.id })
        expect((await patch(alice.id, { action: 'coworker', connectionId: provider.id, model: 'model-coworker' })).effective).toMatchObject({ source: 'coworker', model: 'model-coworker' })
        expect((await patch(bob.id, { action: 'coworker', connectionId: provider.id, model: 'model-bob' })).coworker.model).toBe('model-bob')
        const openChat = await say(alice.id, 'Open a chat', 'model-coworker')
        expect((await patch(alice.id, { action: 'conversation', sessionId: openChat, connectionId: provider.id, model: 'model-chat' })).effective).toMatchObject({ source: 'conversation', model: 'model-chat' })
        expect(await say(alice.id, 'Use this chat’s model', 'model-chat', openChat)).toBe(openChat)
        const followUp = await say(alice.id, 'Use Alice’s pin', 'model-coworker')
        expect(followUp).not.toBe(openChat)
        await say(bob.id, 'Use Bob’s pin', 'model-bob')
        expect((await list(alice.id)).filter(run => run.status === 'done').map(run => run.model).sort()).toEqual(['model-chat', 'model-coworker', 'model-coworker'])
        expect((await list(bob.id)).map(run => run.model)).toEqual(['model-bob'])
        expect((await listConnections(conn)).default).toMatchObject({ connectionId: provider.id, model: 'model-workspace' })
        await patchConnection(conn, provider.id, { models: models.filter(model => model !== 'model-chat'), extraModels: [] })
        const unavailable = await read(alice.id, openChat)
        expect(unavailable.conversation).toMatchObject({ model: 'model-chat', available: false })
        expect(unavailable.coworker).toMatchObject({ model: 'model-coworker', available: true })
        const refused = await chat(call('/api/desktop/chat', 'POST', { agentId: alice.id, sessionId: openChat, text: 'This model is gone' }))
        expect(refused.status).toBe(409)
        expect(await refused.text()).toContain('no longer available')
        expect((await read(bob.id)).coworker.model).toBe('model-bob')
        expect((await listConnections(conn)).default?.model).toBe('model-workspace')
        await say(bob.id, 'Bob still has his model', 'model-bob')
        const saved = { alice: await list(alice.id), bob: await list(bob.id), open: await findDesktopSession(db, openChat), follow: await findDesktopSession(db, followUp) }
        await closeDesktopDatabase(root)
        await fixture.stop()
        await fixture.start()
        expect(await list(alice.id)).toEqual(saved.alice)
        expect(await list(bob.id)).toEqual(saved.bob)
        expect((await read(alice.id, openChat)).conversation).toMatchObject({ model: 'model-chat', available: false })
        expect((await read(alice.id, followUp)).effective).toMatchObject({ source: 'coworker', model: 'model-coworker' })
        expect((await read(bob.id)).effective).toMatchObject({ source: 'coworker', model: 'model-bob' })
        expect((await listConnections({ baseUrl: fixture.runtime.engine.origin, apiKey: fixture.runtime.engine.apiKey })).default?.model).toBe('model-workspace')
        expect((await findDesktopSession(await openDesktopDatabase(root), openChat))?.model).toBe(saved.open?.model)
        expect(saved.follow?.model).toBeNull()
    } finally {
        await closeDesktopDatabase(root)
        await fixture.close()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
}, 90000)
