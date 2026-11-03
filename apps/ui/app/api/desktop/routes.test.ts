import { connectionFixture } from '@/test/desktop-connection-engine'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Memory } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { PATCH as patchSettings } from './settings/route'
import { GET as getBootstrap } from './bootstrap/route'
import { POST as connectProvider } from './providers/openai/route'
import { GET as listAgents, POST as createAgent } from './agents/route'
import { GET as listSessions } from './agents/[agentId]/sessions/route'
import { GET as readCoworkerSettings, PATCH as editCoworkerSettings } from './agents/[agentId]/settings/route'
import { GET as readMemories, POST as addMemory } from './agents/[agentId]/memories/route'
import { DELETE as deleteMemory } from './agents/[agentId]/memories/[memoryId]/route'
import { POST as searchMemories } from './agents/[agentId]/memories/recall/route'
import { GET as getMessages } from './sessions/[sessionId]/messages/route'
import { POST as postChat } from './chat/route'

const originalEnv = { ...process.env }
const sessionToken = 'r'.repeat(48)
let root: string
let server: Server

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-routes-'))
    const connections = connectionFixture()
    type SavedSettings = { soul: string; verbosity: string; tools?: { memory: boolean }; selfImprovement?: { enabled?: boolean; autoMemory?: boolean } }
    const coworkerSettings = new Map<string, SavedSettings>()
    coworkerSettings.set('engine-agent-2', { soul: 'Original instructions', verbosity: 'normal', selfImprovement: { enabled: false } })
    const notes: Record<string, Memory[]> = {
        'engine-agent-1': [{ id: 'first-note', kind: 'fact', tags: ['project'], createdAt: '2026-10-01', content: 'First coworker only', status: 'active', strength: 0.8 }],
        'engine-agent-2': [],
    }
    server = createServer(async (req, res) => {
        let text = ''
        for await (const chunk of req) text += chunk
        const body = text ? JSON.parse(text) : null
        if (connections(req, res, body)) return
        const memoryPath = req.url?.match(/^\/agents\/(engine-agent-[12])\/memories(?:\/([a-zA-Z0-9_-]+))?$/)
        if (memoryPath) {
            const owner = memoryPath[1]!
            const id = memoryPath[2]
            const list = notes[owner]!
            if (req.method === 'GET') return res.end(JSON.stringify({ memories: list }))
            if (req.method === 'POST' && id === 'recall') {
                if (body.query === 'unavailable') return res.writeHead(503).end()
                if (body.limit !== 5 || body.includeDormant !== false) return res.writeHead(400).end()
                return res.end(JSON.stringify({ memories: list.filter(note => note.content.includes(body.query)) }))
            }
            if (req.method === 'POST') {
                const memoryId = body.requestId ?? 'created'
                list.push({ id: memoryId, content: body.content, kind: body.kind ?? 'note', tags: body.tags ?? [], createdAt: '2026-10-02' })
                return res.writeHead(201).end(JSON.stringify({ id: memoryId }))
            }
            if (req.method === 'DELETE') {
                if (!list.some(note => note.id === id)) return res.writeHead(404).end()
                notes[owner] = list.filter(note => note.id !== id)
                return res.writeHead(204).end()
            }
        }
        if (req.method === 'POST' && req.url === '/agents') {
            res.writeHead(201, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ id: 'engine-agent-1', config: { name: body.config.name }, soul: '' }))
        }
        if (/^\/agents\/engine-agent-[12]$/.test(req.url ?? '') && (req.method === 'GET' || req.method === 'PATCH')) {
            const id = req.url!.split('/')[2]
            const saved: SavedSettings = coworkerSettings.get(id) ?? { soul: 'Original instructions', verbosity: 'normal' }
            if (req.method === 'PATCH') {
                const { tools, selfImprovement, ...textSettings } = body
                if (Object.keys(textSettings).some(key => key !== 'soul' && key !== 'verbosity')) return res.writeHead(400).end()
                if (tools && Object.keys(tools).some(key => key !== 'memory')) return res.writeHead(400).end()
                if (selfImprovement && Object.keys(selfImprovement).some(key => key !== 'autoMemory')) return res.writeHead(400).end()
                Object.assign(saved, textSettings)
                if (tools) saved.tools = { ...saved.tools, ...tools }
                if (selfImprovement) saved.selfImprovement = { ...saved.selfImprovement, ...selfImprovement }
                coworkerSettings.set(id, saved)
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ id, config: { name: id, verbosity: saved.verbosity, tools: saved.tools, selfImprovement: saved.selfImprovement }, soul: saved.soul, install: 'engine-only' }))
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
    it('looks up memories by local coworker and keeps an empty list distinct from a missing coworker', async () => {
        const db = await openDesktopDatabase(root)
        const first = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'First', description: '' })
        const second = await createDesktopAgent(db, { engineAgentId: 'engine-agent-2', name: 'Second', description: '' })
        const read = (id: string, anonymous = false) => {
            const req = request(`/api/desktop/agents/${id}/memories`)
            if (anonymous) req.headers.delete('cookie')
            return readMemories(req, { params: Promise.resolve({ agentId: id }) })
        }
        expect((await read(first.id, true)).status).toBe(401)
        expect((await read('engine-agent-1')).status).toBe(404)
        const response = await read(first.id)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toMatchObject({ memories: [{ id: 'first-note', content: 'First coworker only', tags: ['project'], strength: 0.8 }] })
        expect(await (await read(second.id)).json()).toEqual({ memories: [] })
    })

    it('recalls notes through the authenticated local coworker mapping and distinguishes no matches from a failed search', async () => {
        const db = await openDesktopDatabase(root)
        const first = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'First' })
        const second = await createDesktopAgent(db, { engineAgentId: 'engine-agent-2', name: 'Second' })
        const recall = (id: string, body: unknown, adjust?: (req: Request) => void) => {
            const req = request(`/api/desktop/agents/${id}/memories/recall`, { method: 'POST', body })
            adjust?.(req)
            return searchMemories(req, { params: Promise.resolve({ agentId: id }) })
        }
        const query = { query: '  First coworker  ' }
        expect((await recall(first.id, query, req => req.headers.delete('cookie'))).status).toBe(401)
        expect((await recall(first.id, query, req => req.headers.set('origin', 'https://example.invalid'))).status).toBe(403)
        expect((await recall('engine-agent-1', query)).status).toBe(404)
        expect((await recall(first.id, { query: '   ' })).status).toBe(400)
        expect((await recall(first.id, { ...query, limit: 21 })).status).toBe(400)
        const match = await recall(first.id, query)
        expect(match.status).toBe(200)
        expect(match.headers.get('cache-control')).toBe('no-store')
        expect(await match.json()).toMatchObject({ memories: [{ id: 'first-note', content: 'First coworker only' }] })
        expect(await (await recall(second.id, query)).json()).toEqual({ memories: [] })
        expect((await recall(first.id, { query: 'unavailable' })).status).toBe(502)
    })

    it('adds and deletes only the selected local coworker’s note through authenticated same-origin writes', async () => {
        const db = await openDesktopDatabase(root)
        const first = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'First' })
        const second = await createDesktopAgent(db, { engineAgentId: 'engine-agent-2', name: 'Second' })
        const url = (id: string) => `/api/desktop/agents/${id}/memories`
        const ctx = (id: string) => ({ params: Promise.resolve({ agentId: id }) })
        const key = crypto.randomUUID()
        const body = { content: '  Other note  ', kind: 'task', tags: [' label '], requestId: key }
        const post = (id: string, fields: unknown) => addMemory(request(url(id), { method: 'POST', body: fields }), ctx(id))
        const list = async (id: string) => (await (await readMemories(request(url(id)), ctx(id))).json()).memories
        const remove = (id: string, memoryId: string) => deleteMemory(request(url(id) + '/' + memoryId, { method: 'DELETE' }), { params: Promise.resolve({ agentId: id, memoryId }) })
        const foreign = request(url(second.id), { method: 'POST', body })
        foreign.headers.set('origin', 'https://example.invalid')
        expect((await addMemory(foreign, ctx(second.id))).status).toBe(403)
        const anonymous = request(url(second.id) + '/' + key, { method: 'DELETE' })
        anonymous.headers.delete('cookie')
        expect((await deleteMemory(anonymous, { params: Promise.resolve({ agentId: second.id, memoryId: key }) })).status).toBe(401)
        expect((await post(second.id, { content: ' ' })).status).toBe(400)
        expect((await post(second.id, { ...body, agentId: first.id })).status).toBe(400)
        expect((await post('engine-agent-2', body)).status).toBe(404)
        const created = await post(second.id, body)
        expect(created.status).toBe(201)
        expect(await created.json()).toEqual({ id: key })
        expect(await list(second.id)).toMatchObject([{ id: key, content: 'Other note', kind: 'task', tags: ['label'] }])
        expect((await remove(first.id, key)).status).toBe(404)
        expect((await remove(second.id, '..')).status).toBe(400)
        expect((await remove(second.id, 'recall')).status).toBe(400)
        expect((await remove(second.id, key)).status).toBe(204)
        expect(await list(second.id)).toEqual([])
        expect(await list(first.id)).toMatchObject([{ id: 'first-note' }])
    })

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

    it('edits only the local coworker and fields requested, and reads the saved instructions after reopening', async () => {
        const db = await openDesktopDatabase(root)
        const first = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Reviewer' })
        const second = await createDesktopAgent(db, { engineAgentId: 'engine-agent-2', name: 'Researcher' })
        const ctx = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
        const url = (id: string) => `/api/desktop/agents/${id}/settings`
        const patch = (body: unknown) => editCoworkerSettings(request(url(first.id), { method: 'PATCH', body }), ctx(first.id))
        const get = (id: string) => readCoworkerSettings(request(url(id)), ctx(id))

        const defaults = { soul: 'Original instructions', verbosity: 'normal', soulEditable: true, memoryEnabled: true, autoMemory: true, selfImprovementEnabled: true }
        expect(await (await get(first.id)).json()).toEqual(defaults)
        expect((await patch({ soul: '  End with a verdict.  ' })).status).toBe(200)
        expect((await patch({ verbosity: 'concise' })).status).toBe(200)
        for (const body of [{ verbosity: 'other' }, { soul: '  ' }, {}, { model: 'other', verbosity: 'detailed' }, { autoMemory: 'false' }, { memoryEnabled: null }, { selfImprovementEnabled: true }]) {
            expect((await patch(body)).status).toBe(400)
        }
        const foreign = request(url(first.id), { method: 'PATCH', body: { verbosity: 'detailed' } })
        foreign.headers.set('origin', 'https://example.invalid')
        expect((await editCoworkerSettings(foreign, ctx(first.id))).status).toBe(403)
        const anonymous = request(url(first.id))
        anonymous.headers.delete('cookie')
        expect((await readCoworkerSettings(anonymous, ctx(first.id))).status).toBe(401)
        expect((await get('engine-agent-1')).status).toBe(404)
        expect((await editCoworkerSettings(request(url('engine-agent-1'), { method: 'PATCH', body: { soul: 'Wrong ID' } }), ctx('engine-agent-1'))).status).toBe(404)
        await closeDesktopDatabase(root)
        expect(await (await get(first.id)).json()).toEqual({ ...defaults, soul: 'End with a verdict.', verbosity: 'concise' })
        expect(await (await get(second.id)).json()).toEqual({ ...defaults, selfImprovementEnabled: false })
    })

    it('persists independent memory preferences and leaves the self-improvement master and the other coworker alone', async () => {
        const db = await openDesktopDatabase(root)
        const first = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Reviewer' })
        const second = await createDesktopAgent(db, { engineAgentId: 'engine-agent-2', name: 'Researcher' })
        const settings = async (agentId: string, change?: Record<string, boolean>) => {
            const path = `/api/desktop/agents/${agentId}/settings`
            const ctx = { params: Promise.resolve({ agentId }) }
            const res = change ? await editCoworkerSettings(request(path, { method: 'PATCH', body: change }), ctx) : await readCoworkerSettings(request(path), ctx)
            expect(res.status).toBe(200)
            return res.json()
        }
        expect(await settings(first.id, { autoMemory: false })).toMatchObject({ memoryEnabled: true, autoMemory: false })
        expect(await settings(first.id, { memoryEnabled: false })).toMatchObject({ memoryEnabled: false, autoMemory: false })
        expect(await settings(second.id, { memoryEnabled: false })).toMatchObject({ memoryEnabled: false, autoMemory: true, selfImprovementEnabled: false })
        await closeDesktopDatabase(root)
        expect(await settings(second.id, { memoryEnabled: true })).toMatchObject({ memoryEnabled: true, autoMemory: true, selfImprovementEnabled: false })
        expect(await settings(second.id, { autoMemory: false })).toMatchObject({ memoryEnabled: true, autoMemory: false, selfImprovementEnabled: false })
        expect(await settings(first.id)).toMatchObject({ memoryEnabled: false, autoMemory: false, selfImprovementEnabled: true })
    })

    it('reopens the workspace appearance independently of the renderer origin', async () => {
        const write = request('/api/desktop/settings', { method: 'PATCH', body: { action: 'appearance', theme: 'dark' } })
        expect((await patchSettings(write)).status).toBe(200)
        await closeDesktopDatabase(root)
        const bootstrap = await getBootstrap(request('/api/desktop/bootstrap'))
        expect((await bootstrap.json()).theme).toBe('dark')
    })

    it('validates input before calling the engine', async () => {
        expect((await connectProvider(request('/api/desktop/providers/openai', { method: 'POST', body: { apiKey: '' } }))).status).toBe(400)
        expect((await createAgent(request('/api/desktop/agents', { method: 'POST', body: { name: '' } }))).status).toBe(400)
        expect((await postChat(request('/api/desktop/chat', { method: 'POST', body: { agentId: 'missing', text: '' } }))).status).toBe(400)
        expect((await postChat(request('/api/desktop/chat', { method: 'POST', body: { agentId: 'missing', text: 'Hello' } }))).status).toBe(404)
    })
})
