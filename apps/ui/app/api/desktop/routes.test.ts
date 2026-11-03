import { connectionFixture } from '@/test/desktop-connection-engine'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase } from '@/lib/desktop/server/database'
import { PATCH as patchSettings } from './settings/route'
import { GET as getBootstrap } from './bootstrap/route'
import { POST as connectProvider } from './providers/openai/route'
import { GET as listAgents, POST as createAgent } from './agents/route'
import { GET as listSessions } from './agents/[agentId]/sessions/route'
import { GET as getMessages } from './sessions/[sessionId]/messages/route'
import { POST as postChat } from './chat/route'

const originalEnv = { ...process.env }
const sessionToken = 'r'.repeat(48)
let root: string
let server: Server

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-routes-'))
    const connections = connectionFixture()
    server = createServer(async (req, res) => {
        let text = ''
        for await (const chunk of req) text += chunk
        const body = text ? JSON.parse(text) : null
        if (connections(req, res, body)) return
        if (req.method === 'POST' && req.url === '/agents') {
            res.writeHead(201, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ id: 'engine-agent-1', config: { name: body.config.name }, soul: '' }))
        }
        if (req.method === 'POST' && req.url === '/agents/engine-agent-1/chat') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': 'engine-session-1', 'x-run-id': 'run-1' })
            return res.end('data: {"type":"text-delta","delta":"Hello back"}\n\n')
        }
        if (req.method === 'GET' && req.url === '/agents/engine-agent-1/sessions/engine-session-1/messages') {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ messages: [{ id: 'message-1', sessionId: 'engine-session-1', role: 'user', contentJson: JSON.stringify({ text: 'Hello' }), toolCallsJson: null, createdAt: '2026-01-01T00:00:00.000Z' }] }))
        }
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test engine address')
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1,
        launchNonce: 'route-launch',
        buildId: 'route-build',
        workspaceId: 1,
        dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken },
        engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'engine-secret' },
    }), { mode: 0o600 })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

function request(path: string, init: { method?: string; body?: unknown } = {}) {
    const method = init.method ?? 'GET'
    return new Request(`http://127.0.0.1:3100${path}`, {
        method,
        headers: {
            host: '127.0.0.1:3100',
            cookie: `rerun-desktop-session=${sessionToken}`,
            ...(method !== 'GET' ? { origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
}

describe('desktop API routes', () => {
    it('runs provider, coworker, chat, session, and history flows without exposing engine internals', async () => {
        const provider = await connectProvider(request('/api/desktop/providers/openai', { method: 'POST', body: { apiKey: 'provider-secret' } }))
        expect(provider.status).toBe(201)
        expect((await provider.json()).connection).toEqual({ id: 'connection-1', provider: 'openai', name: 'OpenAI' })

        const created = await createAgent(request('/api/desktop/agents', { method: 'POST', body: { name: 'Researcher', description: 'Finds answers' } }))
        expect(created.status).toBe(201)
        const createdBody = await created.json()
        const agentId = createdBody.agent.id as string
        expect(createdBody.agent).toMatchObject({ name: 'Researcher', description: 'Finds answers' })
        expect(JSON.stringify(createdBody)).not.toContain('engine-agent-1')

        const agents = await listAgents(request('/api/desktop/agents'))
        const agentList = await agents.json()
        expect(agentList.agents).toHaveLength(1)
        expect(JSON.stringify(agentList)).not.toContain('engine-agent-1')

        const bootstrap = await getBootstrap(request('/api/desktop/bootstrap'))
        const bootstrapBody = await bootstrap.json()
        expect(bootstrapBody).toMatchObject({ profile: { id: 1, displayName: 'Local User' }, workspace: { id: 1, name: 'My workspace' } })
        expect(bootstrapBody.agents).toHaveLength(1)
        expect(bootstrapBody.connections).toHaveLength(1)
        expect(JSON.stringify(bootstrapBody)).not.toContain('provider-secret')

        const chat = await postChat(request('/api/desktop/chat', { method: 'POST', body: { agentId, text: 'Hello' } }))
        expect(chat.status).toBe(200)
        const localSessionId = chat.headers.get('x-session-id')!
        expect(localSessionId).not.toBe('engine-session-1')
        expect(await chat.text()).toContain('Hello back')

        const sessions = await listSessions(request(`/api/desktop/agents/${agentId}/sessions`), { params: Promise.resolve({ agentId }) })
        const sessionBody = await sessions.json()
        expect(sessionBody.sessions).toHaveLength(1)
        expect(sessionBody.sessions[0].id).toBe(localSessionId)
        expect(JSON.stringify(sessionBody)).not.toContain('engine-session-1')

        const messages = await getMessages(request(`/api/desktop/sessions/${localSessionId}/messages`), { params: Promise.resolve({ sessionId: localSessionId }) })
        const messageBody = await messages.json()
        expect(messageBody.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] })
    })

    it('requires a local session and same origin for settings, and never returns a key', async () => {
        const write = () => request('/api/desktop/settings', { method: 'PATCH', body: { action: 'key', provider: 'google', apiKey: 'fixture-only-secret' } })
        const foreign = write()
        foreign.headers.set('origin', 'https://example.invalid')
        expect((await patchSettings(foreign)).status).toBe(403)
        const anonymous = write()
        anonymous.headers.delete('cookie')
        expect((await patchSettings(anonymous)).status).toBe(401)
        const saved = await patchSettings(write())
        expect(saved.status).toBe(200)
        const reply = await saved.text()
        expect(reply).toContain('"provider":"google"')
        expect(reply).not.toContain('fixture-only-secret')
        expect((await patchSettings(request('/api/desktop/settings', { method: 'PATCH', body: { action: 'key', provider: 'codex', apiKey: 'test' } }))).status).toBe(400)
        expect((await patchSettings(request('/api/desktop/settings', { method: 'PATCH', body: { action: 'default', connectionId: 'connection-1', model: 'not-offered' } }))).status).toBe(400)
    })

    it('validates input before calling the engine', async () => {
        expect((await connectProvider(request('/api/desktop/providers/openai', { method: 'POST', body: { apiKey: '' } }))).status).toBe(400)
        expect((await createAgent(request('/api/desktop/agents', { method: 'POST', body: { name: '' } }))).status).toBe(400)
        expect((await postChat(request('/api/desktop/chat', { method: 'POST', body: { agentId: 'missing', text: '' } }))).status).toBe(400)
        expect((await postChat(request('/api/desktop/chat', { method: 'POST', body: { agentId: 'missing', text: 'Hello' } }))).status).toBe(404)
    })
})
