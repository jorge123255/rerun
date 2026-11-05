import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { POST as postChat } from '@/app/api/desktop/chat/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, findDesktopSession } from '@/lib/desktop/server/store'
import { GET, PATCH } from './route'

const originalEnv = { ...process.env }
let root: string
let server: Server
let alice: string
let bob: string
const requests: string[] = []
const chats: Array<Record<string, unknown>> = []
const agents = new Map<string, { name: string; connectionId: string | null; provider: string | null; model: string | null }>()
let connections: Array<Record<string, unknown>>
let boxDefault: Record<string, unknown> | null

const local = { id: 'conn-local', name: 'Local', provider: 'openrouter', models: ['model-workspace', 'model-coworker', 'model-chat', 'model-bob'], extraModels: [], createdAt: '2026-01-01T00:00:00.000Z', connected: true, credentialRejected: false, planLimits: null }
const codex = { id: 'codex', name: 'ChatGPT', provider: 'codex', models: ['terra', 'luna'], extraModels: [], createdAt: '2026-01-01T00:00:00.000Z', connected: true, credentialRejected: false, planLimits: null, codexReasoning: { terra: { supported: ['low', 'medium', 'high'], default: 'medium' }, luna: { supported: ['low', 'medium'], default: 'low' } } }

function request(path: string, init?: { method?: string; body?: unknown }) {
    return new Request(`http://127.0.0.1:3189${path}`, {
        method: init?.method ?? 'GET',
        headers: { host: '127.0.0.1:3189', origin: 'http://127.0.0.1:3189', cookie: `rerun-desktop-session=${'r'.repeat(48)}`, 'content-type': 'application/json' },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
}
const readModel = async (agentId: string, sessionId?: string) => {
    const response = await GET(request(`/api/desktop/agents/${agentId}/model${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`), { params: Promise.resolve({ agentId }) })
    return { status: response.status, body: await response.json() }
}
const patchModel = async (agentId: string, body: unknown) => {
    const response = await PATCH(request(`/api/desktop/agents/${agentId}/model`, { method: 'PATCH', body }), { params: Promise.resolve({ agentId }) })
    return { status: response.status, body: await response.json() }
}
async function send(body: Record<string, unknown>) {
    const response = await postChat(request('/api/desktop/chat', { method: 'POST', body }))
    const payload = response.status === 200 ? null : await response.json()
    if (response.status === 200) await response.body?.cancel()
    return { status: response.status, payload, sessionId: response.headers.get('x-session-id') }
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-chat-model-'))
    requests.length = 0
    chats.length = 0
    connections = [structuredClone(local), structuredClone(codex)]
    boxDefault = { connectionId: 'conn-local', model: 'model-workspace' }
    agents.clear()
    agents.set('engine-alice', { name: 'Alice', connectionId: 'conn-local', provider: 'openrouter', model: null })
    agents.set('engine-bob', { name: 'Bob', connectionId: 'conn-local', provider: 'openrouter', model: null })
    server = createServer(async (req, res) => {
        let text = ''
        for await (const chunk of req) text += chunk
        const body = text ? JSON.parse(text) as Record<string, unknown> : null
        requests.push(`${req.method} ${req.url}`)
        const sendJson = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
        const setup = req.url?.match(/^\/agents\/([^/]+)\/setup$/)
        if (req.method === 'GET' && setup && agents.has(setup[1])) return sendJson({
            required: false, prompt: '', completedAt: null, sessionId: null, pending: false, revision: 'fixture-setup',
        })
        if (req.method === 'GET' && req.url === '/connections') return sendJson({ connections, default: boxDefault })
        if (req.method === 'PUT' && req.url === '/connections/default') { boxDefault = body; return sendJson(body) }
        const agentMatch = req.url?.match(/^\/agents\/([^/]+)$/)
        if (agentMatch && (req.method === 'GET' || req.method === 'PATCH')) {
            const agent = agents.get(agentMatch[1])
            if (!agent) return sendJson({ error: 'missing' }, 404)
            if (req.method === 'PATCH' && body) {
                if ('connectionId' in body) agent.connectionId = body.connectionId as string | null
                if ('provider' in body) agent.provider = body.provider as string | null
                if ('model' in body) agent.model = body.model as string | null
            }
            return sendJson({ id: agentMatch[1], config: agent, soul: '' })
        }
        if (req.method === 'POST' && /^\/agents\/[^/]+\/chat$/.test(req.url ?? '')) {
            chats.push(body ?? {})
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': String(body?.sessionId ?? `engine-${chats.length}`), 'x-run-id': `run-${chats.length}` })
            return res.end('data: {"type":"finish"}\n\n')
        }
        sendJson({ error: 'not found' }, 404)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test engine address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'chat-model', buildId: 'chat-model-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3189', sessionToken: 'r'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-engine' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    await new Promise<void>(resolve => server.close(() => resolve()))
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('a conversation override, a coworker pin, and the workspace default stay independent', async () => {
    expect((await patchModel(alice, { action: 'coworker', connectionId: 'conn-local', model: 'model-coworker' })).status).toBe(200)
    expect((await patchModel(bob, { action: 'coworker', connectionId: 'conn-local', model: 'model-bob' })).status).toBe(200)
    const first = await send({ agentId: alice, text: 'Already open' })
    expect(first.status).toBe(200)
    const openChat = first.sessionId!
    expect(chats.at(-1)).toMatchObject({ model: 'model-coworker', connectionId: 'conn-local' })
    expect(chats.at(-1)).not.toHaveProperty('reasoningEffort')
    expect((await patchModel(alice, { action: 'conversation', sessionId: openChat, connectionId: 'conn-local', model: 'model-chat' })).body.effective).toMatchObject({ source: 'conversation', model: 'model-chat' })
    expect(agents.get('engine-alice')?.model).toBe('model-coworker')
    const again = await send({ agentId: alice, sessionId: openChat, text: 'Use the chat model' })
    expect(again.sessionId).toBe(openChat)
    expect(chats.at(-1)).toMatchObject({ model: 'model-chat', sessionId: 'engine-1' })
    const second = await send({ agentId: alice, text: 'Follow Alice' })
    expect(chats.at(-1)).toMatchObject({ model: 'model-coworker' })
    expect(second.sessionId).not.toBe(openChat)
    const unaffected = await send({ agentId: bob, text: 'Bob stays' })
    expect(chats.at(-1)).toMatchObject({ model: 'model-bob' })
    ;(connections[0].models as string[]).push('model-next')
    boxDefault = { connectionId: 'conn-local', model: 'model-next' }
    expect((await send({ agentId: bob, sessionId: unaffected.sessionId!, text: 'Bob again' })).status).toBe(200)
    expect(chats.at(-1)).toMatchObject({ model: 'model-bob' })
    expect((await send({ agentId: alice, sessionId: openChat, text: 'Chat stays' })).status).toBe(200)
    expect(chats.at(-1)).toMatchObject({ model: 'model-chat' })
    expect((await send({ agentId: alice, sessionId: second.sessionId!, text: 'Alice pin stays' })).status).toBe(200)
    expect(chats.at(-1)).toMatchObject({ model: 'model-coworker' })
    const followed = await patchModel(alice, { action: 'follow-workspace', sessionId: openChat })
    expect(followed.body.effective).toMatchObject({ source: 'workspace', model: 'model-next' })
    expect(agents.get('engine-alice')?.model).toBeNull()
    expect(agents.get('engine-bob')?.model).toBe('model-bob')
    expect((await findDesktopSession(await openDesktopDatabase(root), openChat))?.model).toBeNull()
    expect((await findDesktopSession(await openDesktopDatabase(root), second.sessionId!))?.model).toBeNull()
    expect((await send({ agentId: bob, text: 'Still Bob' })).status).toBe(200)
    expect(chats.at(-1)).toMatchObject({ model: 'model-bob' })
    expect(requests.filter(item => item.startsWith('PUT /connections/default'))).toEqual([])
    expect(boxDefault).toEqual({ connectionId: 'conn-local', model: 'model-next' })
})

test('an unavailable saved model is refused and survives restart without changing the other defaults', async () => {
    const db = await openDesktopDatabase(root)
    const session = await createDesktopSession(db, { agentId: alice, engineSessionId: 'engine-open', title: 'Open' })
    const other = await createDesktopSession(db, { agentId: alice, engineSessionId: 'engine-other', title: 'Other', model: { connectionId: 'conn-local', model: 'model-coworker' } })
    expect((await patchModel(alice, { action: 'coworker', connectionId: 'conn-local', model: 'model-bob' })).status).toBe(200)
    expect((await patchModel(alice, { action: 'conversation', sessionId: session.id, connectionId: 'conn-local', model: 'model-chat' })).status).toBe(200)
    connections[0].models = ['model-workspace', 'model-coworker', 'model-bob']
    const view = await readModel(alice, session.id)
    expect(view.body.conversation).toMatchObject({ model: 'model-chat', available: false })
    expect(view.body.effective).toMatchObject({ source: 'conversation', available: false })
    expect(view.body.coworker).toMatchObject({ model: 'model-bob', available: true })
    const refused = await send({ agentId: alice, sessionId: session.id, text: 'Continue' })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.payload)).toContain('no longer available')
    expect(chats).toEqual([])
    expect(agents.get('engine-alice')?.model).toBe('model-bob')
    expect(boxDefault).toMatchObject({ model: 'model-workspace' })
    expect((await findDesktopSession(db, other.id))?.model).toBe('model-coworker')
    await closeDesktopDatabase(root)
    const reopened = await readModel(alice, session.id)
    expect(reopened.body.conversation).toMatchObject({ model: 'model-chat', available: false })
    expect(reopened.body.coworker.model).toBe('model-bob')
    expect((await findDesktopSession(await openDesktopDatabase(root), session.id))?.model).toBe('model-chat')
})

test('rejects an unoffered model and a foreign conversation before it changes a pin', async () => {
    expect((await patchModel(alice, { action: 'coworker', connectionId: 'conn-local', model: 'model-coworker' })).status).toBe(200)
    const foreign = await createDesktopSession(await openDesktopDatabase(root), { agentId: bob, engineSessionId: 'engine-bob-chat', title: 'Bob' })
    expect((await patchModel(alice, { action: 'follow-workspace', sessionId: foreign.id })).status).toBe(404)
    expect(agents.get('engine-alice')?.model).toBe('model-coworker')
    expect((await patchModel(alice, { action: 'conversation', sessionId: foreign.id, connectionId: 'conn-local', model: 'model-chat' })).status).toBe(404)
    expect((await patchModel(alice, { action: 'coworker', connectionId: 'conn-local', model: 'missing' })).status).toBe(400)
    expect((await patchModel(alice, { action: 'conversation', sessionId: 'missing', connectionId: 'conn-local', model: 'model-chat' })).status).toBe(404)
    expect(agents.get('engine-alice')?.model).toBe('model-coworker')
    expect((await patchModel(alice, { action: 'nope' })).status).toBe(400)
    expect(requests.filter(item => item.startsWith('PUT /connections/default'))).toEqual([])
})

test('shows Codex reasoning from the workspace or the model default and does not save a new effort', async () => {
    boxDefault = { connectionId: 'codex', model: 'terra', reasoningEffort: 'high' }
    const session = await createDesktopSession(await openDesktopDatabase(root), { agentId: alice, engineSessionId: 'engine-codex', title: 'Codex' })
    expect((await readModel(alice, session.id)).body.effective).toMatchObject({ source: 'workspace', model: 'terra', reasoning: { effort: 'high', source: 'workspace' } })
    const picked = await patchModel(alice, { action: 'conversation', sessionId: session.id, connectionId: 'codex', model: 'luna' })
    expect(picked.body.effective).toMatchObject({ source: 'conversation', model: 'luna', reasoning: { effort: 'low', source: 'model-default' } })
    expect(boxDefault).toEqual({ connectionId: 'codex', model: 'terra', reasoningEffort: 'high' })
    expect((await patchModel(alice, { action: 'coworker', connectionId: 'codex', model: 'terra', sessionId: session.id })).body.effective).toMatchObject({ source: 'conversation', model: 'luna', reasoning: { effort: 'low', source: 'model-default' } })
    expect((await patchModel(alice, { action: 'conversation-follow', sessionId: session.id })).body.effective).toMatchObject({ source: 'coworker', model: 'terra', reasoning: { effort: 'high', source: 'workspace' } })
    expect(agents.get('engine-bob')?.model).toBeNull()
    expect(requests.filter(item => item.startsWith('PUT /connections/default'))).toEqual([])
})
