import { GET as readTools, PATCH as editTool } from './agents/[agentId]/tools/route'
import { connectionFixture } from '@/test/desktop-connection-engine'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Memory } from '@rerun/contracts'
import { DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, listDesktopSessions } from '@/lib/desktop/server/store'
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
const sentChats: unknown[] = []

beforeEach(async () => {
    sentChats.length = 0
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-routes-'))
    const connections = connectionFixture()
    type SavedSettings = { soul: string; verbosity: string; tools?: { memory?: boolean; desktopWorkspaceRead?: boolean; desktopToolGrants?: Record<string, boolean>; desktopCodexGrants?: Record<string, boolean> }; selfImprovement?: { enabled?: boolean; autoMemory?: boolean } }
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
                if (tools && Object.keys(tools).some(key => key !== 'memory' && key !== 'desktopWorkspaceRead' && key !== 'desktopToolGrants' && key !== 'desktopCodexGrants')) return res.writeHead(400).end()
                if (selfImprovement && Object.keys(selfImprovement).some(key => key !== 'autoMemory')) return res.writeHead(400).end()
                Object.assign(saved, textSettings)
                if (tools) saved.tools = { ...saved.tools, ...tools }
                if (selfImprovement) saved.selfImprovement = { ...saved.selfImprovement, ...selfImprovement }
                coworkerSettings.set(id, saved)
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ id, config: { name: id, verbosity: saved.verbosity, tools: saved.tools, selfImprovement: saved.selfImprovement }, soul: saved.soul, install: 'engine-only' }))
        }
        if (req.method === 'POST' && /^\/agents\/engine-agent-[12]\/chat$/.test(req.url ?? '')) {
            sentChats.push(body)
            if (body.regenerateMessageId) {
                if (body.regenerateMessageId === 'missing') return res.writeHead(404).end()
                if (body.regenerateMessageId === 'busy') return res.writeHead(409).end()
                const replay = sentChats.filter(value => (value as { requestId?: string }).requestId === body.requestId).length > 1
                res.writeHead(replay ? 204 : 200, { 'x-session-id': 'alternate-' + body.requestId, 'x-run-id': 'alternate-run' })
                return res.end(replay ? undefined : 'data: [DONE]\n\n')
            }
            const engineSessionId = req.url?.includes('engine-agent-1') ? 'engine-session-1' : 'engine-session-2'
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': engineSessionId, 'x-run-id': 'run-1' })
            return res.end('data: {"type":"text-delta","delta":"Hello back"}\n\n')
        }
        if (req.method === 'GET' && req.url === '/agents/engine-agent-1/sessions/engine-session-1/messages') {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ messages: [{ id: 'message-1', sessionId: 'engine-session-1', role: 'user', contentJson: JSON.stringify({ text: 'Hello' }), toolCallsJson: null, createdAt: '2026-01-01T00:00:00.000Z' }] }))
        }
        if (req.method === 'GET' && /^\/agents\/engine-agent-1\/sessions\/alternate-[\da-f-]+\/messages$/.test(req.url ?? '')) {
            return res.end(JSON.stringify({ messages: [] }))
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
    it('registers an alternate once, maps durable message IDs and keeps its owner and source distinct', async () => {
        await connectProvider(request('/api/desktop/providers/openai', { method: 'POST', body: { apiKey: 'fixture-key' } }))
        const db = await openDesktopDatabase(root)
        const a = await createDesktopAgent(db, { name: 'First', engineAgentId: 'engine-agent-1' })
        const b = await createDesktopAgent(db, { name: 'Second', engineAgentId: 'engine-agent-2' })
        const source = await createDesktopSession(db, { agentId: a.id, engineSessionId: 'source-session', title: 'Original chat' })
        const body = { agentId: a.id, sessionId: source.id, regenerateMessageId: 'engine-saved-row', requestId: crypto.randomUUID() }
        const post = (overrides = {}) => postChat(request('/api/desktop/chat', { method: 'POST', body: { ...body, ...overrides } }))
        expect((await post({ agentId: b.id })).status).toBe(404)
        for (const extra of [{ text: 'substitute question' }, { attachmentPath: 'substitute.txt' }, { requestId: 'invalid' }, { regenerateMessageId: 'transient' }]) {
            expect((await post(extra)).status).toBe(400)
        }
        expect(sentChats).toEqual([])
        expect((await post({ regenerateMessageId: 'engine-missing', requestId: crypto.randomUUID() })).status).toBe(404)
        expect((await post({ regenerateMessageId: 'engine-busy', requestId: crypto.randomUUID() })).status).toBe(409)
        expect(await listDesktopSessions(db, a.id)).toEqual([source])
        const replies = await Promise.all([post(), post()])
        const [first, replay] = replies
        expect(first.headers.get('x-session-id')).toBe(replay.headers.get('x-session-id'))
        expect(first.headers.get('x-session-id')).not.toBe(source.id)
        for (const result of replies) {
            expect(result.status).toBe(200)
            expect(result.headers.get('x-run-id')).toBe('alternate-run')
            expect(await result.text()).toBe('data: [DONE]\n\n')
        }
        expect(sentChats.at(-1)).toMatchObject({ sessionId: source.engineSessionId, regenerateMessageId: 'saved-row', requestId: body.requestId })
        expect(sentChats.at(-1)).not.toHaveProperty('message')
        expect(sentChats.at(-1)).not.toHaveProperty('workspaceAttachment')
        expect((await listDesktopSessions(db, a.id)).map(s => s.title)).toEqual(['Alternate · Original chat', 'Original chat'])
        expect(await listDesktopSessions(db, b.id)).toEqual([])
    })

    it('recovers an unseen alternate after relaunch and allows a fresh one only after its history opens', async () => {
        await connectProvider(request('/api/desktop/providers/openai', { method: 'POST', body: { apiKey: 'fixture-key' } }))
        const db = await openDesktopDatabase(root)
        const agent = await createDesktopAgent(db, { name: 'First', engineAgentId: 'engine-agent-1' })
        const source = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-session-1', title: 'Source' })
        const post = (requestId: string, regenerateMessageId = 'engine-first') => postChat(request('/api/desktop/chat', {
            method: 'POST', body: { agentId: agent.id, sessionId: source.id, regenerateMessageId, requestId },
        }))
        const open = (sessionId: string) => getMessages(request('/api/desktop/sessions/' + sessionId + '/messages'), { params: Promise.resolve({ sessionId }) })
        const originalId = crypto.randomUUID()
        const response = await post(originalId)
        const first = response.headers.get('x-session-id')!
        expect(response.status).toBe(200)
        await closeDesktopDatabase(root)
        // The first response was lost; the new renderer opens the source and makes up a fresh UUID.
        expect((await open(source.id)).status).toBe(200)
        const retryId = crypto.randomUUID()
        const retried = await post(retryId)
        expect(retried.headers.get('x-session-id')).toBe(first)
        expect(sentChats.at(-1)).toMatchObject({ requestId: originalId })
        // Even a fresh alias cannot be used to select a different target with its own pending run.
        const different = await post(crypto.randomUUID(), 'engine-other')
        expect(different.status).toBe(200)
        const count = sentChats.length
        expect((await post(retryId, 'engine-other')).status).toBe(409)
        expect(sentChats).toHaveLength(count)
        expect((await open(first)).status).toBe(200)
        const newId = crypto.randomUUID()
        const next = await post(newId)
        const second = next.headers.get('x-session-id')!
        expect(next.status).toBe(200)
        expect(second).not.toBe(first)
        expect(sentChats.at(-1)).toMatchObject({ requestId: newId })
        // A late retry of the old action and a read of its old alternate cannot consume the new attempt.
        expect((await post(retryId)).headers.get('x-session-id')).toBe(first)
        expect((await open(first)).status).toBe(200)
        expect((await post(crypto.randomUUID())).headers.get('x-session-id')).toBe(second)
    })

    it('reads only an explicitly attached file from the selected coworker before dispatching chat', async () => {
        await connectProvider(request('/api/desktop/providers/openai', { method: 'POST', body: { apiKey: 'fixture-key' } }))
        const db = await openDesktopDatabase(root)
        const agents = await Promise.all(['1', '2'].map(n => createDesktopAgent(db, { name: 'Agent '+n, engineAgentId: 'engine-agent-'+n })))
        const dirs = agents.map(a => join(root, 'workspaces', '1', 'engine', 'agents', a.engineAgentId, 'workspace'))
        const path = 'report, part [2].MD'
        const text = 'What does this say?'
        for (const [index, dir] of dirs.entries()) {
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, path), 'Summary.\r\nAnswer '+index+' 🙂')
        }
        const send = (agentId: string, body: Record<string, unknown>, header?: 'anonymous' | 'foreign') => {
            const req = request('/api/desktop/chat', { method: 'POST', body: { agentId, text, ...body } })
            if (header === 'anonymous') req.headers.delete('cookie')
            if (header === 'foreign') req.headers.set('origin', 'https://example.invalid')
            return postChat(req)
        }
        const attachment = { attachmentPath: path }
        expect((await send(agents[0].id, attachment, 'anonymous')).status).toBe(401)
        expect((await send(agents[0].id, attachment, 'foreign')).status).toBe(403)
        expect((await send(agents[0].engineAgentId, attachment)).status).toBe(404)
        for (const [name, bytes] of [['large.txt', Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES + 1, 65)], ['binary.md', Buffer.from([0, 65])], ['invalid.txt', Buffer.from([0xc3, 0x28])]] as const) {
            await writeFile(join(dirs[0], name), bytes)
        }
        await symlink(join(dirs[1], path), join(dirs[0], 'redirect.txt'))
        for (const [bad, status] of [['large.txt', 413], ['binary.md', 415], ['invalid.txt', 415], ['missing.txt', 404], ['../private.txt', 400], ['/private.txt', 400], ['data.png', 400], ['redirect.txt', 400]] as const) {
            expect((await send(agents[0].id, { attachmentPath: bad })).status).toBe(status)
        }
        expect(sentChats).toEqual([])
        const owner = await send(agents[0].id, attachment)
        expect(owner.status).toBe(200)
        const sessionId = owner.headers.get('x-session-id')
        expect((await send(agents[1].id, { ...attachment, sessionId })).status).toBe(404)
        expect((await send(agents[1].id, attachment)).status).toBe(200)
        for (const [index, body] of sentChats.entries()) {
            expect(body).toMatchObject({ message: text, workspaceAttachment: { path, content: 'Summary.\r\nAnswer '+index+' 🙂' } })
        }
        const plain = 'Literal [Attachments added to your workspace: nonexistent.txt]'
        expect((await send(agents[0].id, { sessionId, text: plain, workspaceAttachment: { path, content: 'client-injected' } })).status).toBe(200)
        expect(sentChats[2]).toMatchObject({ message: plain })
        expect(sentChats[2]).not.toHaveProperty('workspaceAttachment')
        await writeFile(join(dirs[0], 'limit.txt'), Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES, 65))
        expect((await send(agents[0].id, { sessionId, attachmentPath: 'limit.txt' })).status).toBe(200)
        expect(sentChats[3]).toMatchObject({ workspaceAttachment: { content: 'A'.repeat(DESKTOP_ATTACHMENT_MAX_BYTES) } })
    })

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

        const defaults = { soul: 'Original instructions', verbosity: 'normal', soulEditable: true, workspaceReadEnabled: false, memoryEnabled: true, autoMemory: true, selfImprovementEnabled: true }
        expect(await (await get(first.id)).json()).toEqual(defaults)
        expect((await patch({ workspaceReadEnabled: true })).status).toBe(200)
        expect(await (await get(first.id)).json()).toEqual({ ...defaults, workspaceReadEnabled: true })
        expect((await patch({ soul: '  End with a verdict.  ' })).status).toBe(200)
        expect((await patch({ verbosity: 'concise' })).status).toBe(200)
        for (const body of [{ verbosity: 'other' }, { soul: '  ' }, {}, { model: 'other', verbosity: 'detailed' }, { autoMemory: 'false' }, { workspaceReadEnabled: 'true' }, { tools: { filesystem: true } }, { memoryEnabled: null }, { selfImprovementEnabled: true }]) {
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
        expect(await (await get(first.id)).json()).toEqual({ ...defaults, workspaceReadEnabled: true, soul: 'End with a verdict.', verbosity: 'concise' })
        expect(await (await get(second.id)).json()).toEqual({ ...defaults, selfImprovementEnabled: false })
    })

    it('returns the available tool catalogs, keeps grants with their local owner, and rejects unknown or unavailable grants', async () => {
        const db = await openDesktopDatabase(root)
        const alice = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Alice' })
        const bob = await createDesktopAgent(db, { engineAgentId: 'engine-agent-2', name: 'Bob' })
        const context = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
        const path = (id: string) => `/api/desktop/agents/${id}/tools`
        const get = (id: string) => readTools(request(path(id)), context(id))
        const patch = (id: string, body: object) => editTool(request(path(id), { method: 'PATCH', body }), context(id))
        const grant = { group: 'rerun', id: 'workspaceRead', enabled: true }
        const response = await (await patch(alice.id, grant)).json()
        expect(response.rerun).toContainEqual(expect.objectContaining({ id: 'workspaceRead', enabled: true }))
        expect(response.codex).toContainEqual(expect.objectContaining({ id: 'shell', enabled: false }))
        expect((await (await get(bob.id)).json()).rerun).toContainEqual(expect.objectContaining({ id: 'workspaceRead', enabled: false }))
        expect((await patch(alice.id, { ...grant, id: 'requestSecret' })).status).toBe(400)
        expect((await patch(alice.id, { ...grant, id: 'unknown' })).status).toBe(400)
        expect((await get('engine-agent-2')).status).toBe(404)
        expect((await patch('engine-agent-2', grant)).status).toBe(404)
        expect((await (await get(alice.id)).text())).not.toContain('engine-only')
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
