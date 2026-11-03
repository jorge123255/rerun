import { DEFAULT_CONNECTION_MODELS } from '@rerun/contracts'
import { changeDesktopSettings } from './settings'
import { connectionFixture } from '@/test/desktop-connection-engine'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase } from './database'
import { connectDesktopOpenAI, createDesktopCoworker, readDesktopHistory, startDesktopChat } from './engine'
import { createDesktopAgent, createDesktopSession } from './store'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'

type SeenBody = {
    config?: { name: string; displayName?: string; description?: string; connectionId?: string; provider?: string; enabled?: boolean; tools?: unknown; mcpServers?: unknown }
    models?: string[]
    keys?: Record<string, string>
    set?: Record<string, string>
    message?: string
    sessionId?: string
    source?: string
}
type SeenRequest = { method: string; url: string; authorization: string | null; body: SeenBody | null }
const seen: SeenRequest[] = []
let server: Server
let root: string
let runtime: DesktopRuntime

async function bodyOf(req: IncomingMessage) {
    let text = ''
    for await (const chunk of req) text += chunk
    return text ? JSON.parse(text) : null
}

function json(res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
}

beforeEach(async () => {
    seen.length = 0
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-engine-'))
    const connections = connectionFixture()
    server = createServer(async (req, res) => {
        const body = await bodyOf(req)
        seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization ?? null, body })
        if (connections(req, res, body)) return
        if (req.method === 'POST' && req.url === '/agents') {
            return json(res, { id: 'engine-agent-1', config: { name: body.config.name }, soul: '' }, 201)
        }
        if (req.method === 'POST' && req.url === '/agents/engine-agent-1/chat') {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'x-session-id': 'engine-session-1',
                'x-run-id': 'run-1',
                'x-vercel-ai-ui-message-stream': 'v1',
            })
            return res.end('data: {"type":"text-delta","delta":"Hello back"}\n\n')
        }
        if (req.method === 'GET' && req.url === '/agents/engine-agent-1/sessions/engine-session-1/messages') {
            return json(res, { messages: [{ id: 'message-1', sessionId: 'engine-session-1', role: 'user', contentJson: JSON.stringify({ text: 'Hello' }), toolCallsJson: null, createdAt: '2026-01-01T00:00:00.000Z' }] })
        }
        if (req.url === '/agents/engine-agent-1/sessions/unavailable/messages') return json(res, { error: 'engine unavailable' }, 503)
        if (req.url === '/agents/engine-agent-1/sessions/empty/messages') return json(res, { messages: [] })
        json(res, { error: 'not found' }, 404)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test engine address')
    runtime = {
        protocolVersion: 1,
        launchNonce: 'engine-launch',
        buildId: 'engine-build',
        workspaceId: 1,
        dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken: 'e'.repeat(48) },
        engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'engine-secret' },
    }
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

describe('desktop engine workflows', () => {
    it('sends an OpenAI key only to the engine and reconnects without a duplicate connection', async () => {
        await expect(connectDesktopOpenAI(runtime, 'first-api-key')).resolves.toEqual({ id: 'connection-1', provider: 'openai', name: 'OpenAI' })
        await connectDesktopOpenAI(runtime, 'replacement-api-key')
        expect(seen[0].authorization).toBe('Bearer engine-secret')
        expect(seen.find(req => req.method === 'POST')?.body?.keys).toEqual({ OPENAI_API_KEY: 'first-api-key' })
        expect(seen.filter(request => request.method === 'POST' && request.url === '/connections')).toHaveLength(1)
        expect(seen.find(req => req.method === 'PATCH')?.body).toEqual({ set: { OPENAI_API_KEY: 'replacement-api-key' } })
    })

    it('creates a coworker and streams chat with only the local session ID exposed', async () => {
        await connectDesktopOpenAI(runtime, 'api-key')
        const agent = await createDesktopCoworker(runtime, { name: 'Researcher', description: 'Finds answers' })
        const result = await startDesktopChat(runtime, { agentId: agent.id, text: 'Hello' })
        expect(result.sessionId).not.toBe('engine-session-1')
        expect(result.response.headers.get('x-session-id')).toBe(result.sessionId)
        expect(result.response.headers.get('x-session-id')).not.toBe('engine-session-1')
        expect(result.response.headers.get('x-run-id')).toBe('run-1')
        expect(await result.response.text()).toContain('Hello back')
        const create = seen.find(request => request.method === 'POST' && request.url === '/agents')
        expect(create?.body?.config).toMatchObject({ displayName: 'Researcher', description: 'Finds answers', connectionId: 'connection-1', provider: 'openai', enabled: true })
        expect(create?.body?.config?.tools).toBeUndefined()
        expect(create?.body?.config?.mcpServers).toBeUndefined()
        const chat = seen.find(request => request.url === '/agents/engine-agent-1/chat')
        expect(chat?.body).toMatchObject({ message: 'Hello', source: 'dashboard' })
        expect(chat?.body?.sessionId).toBeUndefined()
    })

    it('refuses to create a coworker without a local provider connection', async () => {
        await expect(createDesktopCoworker(runtime, { name: 'Researcher' })).rejects.toMatchObject({ status: 400, message: 'Connect a provider and choose a default model in Settings.' })
        expect(seen.map(req => req.url)).toEqual(['/connections'])
    })

    it('refuses to start chat without a local provider connection', async () => {
        const db = await openDesktopDatabase(root)
        const agent = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Researcher' })
        await expect(startDesktopChat(runtime, { agentId: agent.id, text: 'Hello' })).rejects.toMatchObject({ status: 400, message: 'Connect a provider and choose a default model in Settings.' })
        expect(seen.map(req => req.url)).toEqual(['/connections'])
    })

    it('uses a changed workspace default on an existing coworker and conversation', async () => {
        await connectDesktopOpenAI(runtime, 'example-key')
        const agent = await createDesktopCoworker(runtime, { name: 'Writer' })
        const first = await startDesktopChat(runtime, { agentId: agent.id, text: 'First turn' })
        await first.response.body?.cancel()
        await changeDesktopSettings(runtime, { action: 'key', provider: 'anthropic', apiKey: 'example-claude-key' })
        const model = DEFAULT_CONNECTION_MODELS.anthropic[1]
        await changeDesktopSettings(runtime, { action: 'default', connectionId: 'connection-2', model })
        const second = await startDesktopChat(runtime, { agentId: agent.id, sessionId: first.sessionId, text: 'Second turn' })
        await second.response.body?.cancel()
        expect(seen.filter(r => r.url.endsWith('/chat')).at(-1)?.body).toMatchObject({ connectionId: 'connection-2', model, sessionId: 'engine-session-1' })
        expect(second.sessionId).toBe(first.sessionId)
    })

    it('distinguishes an empty saved conversation from an engine history read failure', async () => {
        const db = await openDesktopDatabase(root)
        const agent = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Test' })
        const history = async (id: string) => {
            const session = await createDesktopSession(db, { agentId: agent.id, engineSessionId: id, title: id })
            return readDesktopHistory(runtime, session.id)
        }
        await expect(history('empty')).resolves.toEqual([])
        await expect(history('unavailable')).rejects.toMatchObject({ status: 502 })
        await expect(history('missing')).rejects.toMatchObject({ status: 404 })
    })

    it('reopens engine history through a local session mapping', async () => {
        await connectDesktopOpenAI(runtime, 'api-key')
        const agent = await createDesktopCoworker(runtime, { name: 'Researcher' })
        const chat = await startDesktopChat(runtime, { agentId: agent.id, text: 'Hello' })
        await chat.response.body?.cancel()
        const history = await readDesktopHistory(runtime, chat.sessionId)
        expect(history).toEqual([{ id: 'engine-message-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }], metadata: { createdAt: '2026-01-01T00:00:00.000Z' } }])
    })
})
