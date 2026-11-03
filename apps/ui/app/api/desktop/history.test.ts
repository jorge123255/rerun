import { DEFAULT_CONNECTION_MODELS } from '@rerun/contracts'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as listSessions } from './agents/[agentId]/sessions/route'
import { GET as getMessages } from './sessions/[sessionId]/messages/route'
import { POST as postChat } from './chat/route'

test('authenticated local history preserves two chats across service restart and isolates another coworker', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-history-restart-'))
    const transcriptPath = join(root, 'synthetic-engine.json')
    type Message = { id: string; sessionId: string; role: string; contentJson: string; toolCallsJson: null; createdAt: string }
    let server: Server | undefined
    let sessionToken = 'history-fixture-launch-one'.repeat(2)
    const engineKey = 'synthetic-history-engine'
    const origin = 'http://127.0.0.1:3100'
    const request = (path: string, body?: unknown, token = sessionToken) => new Request(`${origin}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { host: '127.0.0.1:3100', origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const startEngine = async () => {
        const transcripts: Record<string, Message[]> = JSON.parse(await readFile(transcriptPath, 'utf8'))
        server = createServer(async (req, res) => {
            const json = (value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
            if (req.headers.authorization !== `Bearer ${engineKey}`) return json({ error: 'Unauthorized' }, 401)
            if (req.method === 'GET' && req.url === '/connections') {
                const model = DEFAULT_CONNECTION_MODELS.openai[0]
                return json({ connections: [{ id: 'synthetic', name: 'Synthetic', provider: 'openai', models: [model], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '2026-01-01' }], default: { connectionId: 'synthetic', model } })
            }
            const chat = req.url?.match(/^\/agents\/([^/]+)\/chat$/)
            if (req.method === 'POST' && chat) {
                let text = ''
                for await (const chunk of req) text += chunk
                const body = JSON.parse(text)
                const id = body.sessionId ?? crypto.randomUUID()
                const key = `${chat[1]}/${id}`
                const messages = transcripts[key] ?? []
                for (const [role, content] of [['user', body.message], ['assistant', `Synthetic answer: ${body.message}`]]) {
                    messages.push({ id: crypto.randomUUID(), sessionId: id, role, contentJson: JSON.stringify({ text: content }), toolCallsJson: null, createdAt: new Date().toISOString() })
                }
                transcripts[key] = messages
                await writeFile(transcriptPath, JSON.stringify(transcripts))
                return res.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': id }).end('data: {"type":"finish"}\n\ndata: [DONE]\n\n')
            }
            const history = req.url?.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/)
            if (req.method === 'GET' && history) {
                const messages = transcripts[`${history[1]}/${history[2]}`]
                return messages ? json({ messages }) : json({ error: 'Not found' }, 404)
            }
            return json({ error: 'Unexpected synthetic engine request' }, 404)
        })
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('No test engine address')
        process.env.RERUN_DESKTOP_APP = '1'
        process.env.RERUN_DESKTOP_DATA_DIR = root
        process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
        await writeFile(process.env.RERUN_DESKTOP_RUNTIME_FILE, JSON.stringify({ protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'history-test', workspaceId: 1, dataRoot: root,
            app: { origin, sessionToken }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: engineKey } }), { mode: 0o600 })
    }
    const stopEngine = () => new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    const send = async (agentId: string, text: string, sessionId?: string) => {
        const response = await postChat(request('/api/desktop/chat', { agentId, text, sessionId }))
        expect(response.status).toBe(200)
        await response.text()
        return response.headers.get('x-session-id')!
    }
    const list = async (agentId: string) => {
        const response = await listSessions(request(`/api/desktop/agents/${agentId}/sessions`), { params: Promise.resolve({ agentId }) })
        expect(response.status).toBe(200)
        return (await response.json()).sessions as { id: string; title: string; agentId: string; createdAt: string; updatedAt: string }[]
    }
    const read = async (sessionId: string) => {
        const response = await getMessages(request(`/api/desktop/sessions/${sessionId}/messages`), { params: Promise.resolve({ sessionId }) })
        expect(response.status).toBe(200)
        return response.text()
    }
    try {
        await writeFile(transcriptPath, '{}')
        await startEngine()
        const db = await openDesktopDatabase(root)
        const alice = await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })
        const bob = await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })
        const first = await send(alice.id, 'Apple question')
        const second = await send(alice.id, 'Banana question')
        const other = await send(bob.id, 'Carrot question')
        expect(first).not.toBe(second)
        const before = await list(alice.id)
        expect(before.map(s => s.id)).toEqual([second, first])
        expect(before.map(s => s.title)).toEqual(['Banana question', 'Apple question'])
        expect(await read(first)).toContain('Synthetic answer: Apple question')
        expect(await read(first)).not.toContain('Banana question')
        expect(await read(second)).toContain('Synthetic answer: Banana question')
        expect(await read(second)).not.toContain('Apple question')
        expect((await list(bob.id)).map(s => s.id)).toEqual([other])
        expect(await send(alice.id, 'Apple follow-up', first)).toBe(first)
        expect(await list(alice.id)).toEqual(before)
        expect(await read(first)).toContain('Apple follow-up')
        expect((await postChat(request('/api/desktop/chat', { agentId: bob.id, sessionId: first, text: 'Wrong coworker' }))).status).toBe(404)
        const anonymous = request(`/api/desktop/agents/${alice.id}/sessions`)
        anonymous.headers.delete('cookie')
        expect((await listSessions(anonymous, { params: Promise.resolve({ agentId: alice.id }) })).status).toBe(401)
        const noCookieMessages = request(`/api/desktop/sessions/${first}/messages`)
        noCookieMessages.headers.delete('cookie')
        expect((await getMessages(noCookieMessages, { params: Promise.resolve({ sessionId: first }) })).status).toBe(401)
        await closeDesktopDatabase(root)
        await stopEngine()
        const staleToken = sessionToken
        sessionToken = 'history-fixture-launch-two'.repeat(2)
        await startEngine()
        expect((await listSessions(request(`/api/desktop/agents/${alice.id}/sessions`, undefined, staleToken), { params: Promise.resolve({ agentId: alice.id }) })).status).toBe(401)
        expect(await list(alice.id)).toEqual(before)
        expect(await read(first)).toContain('Apple follow-up')
        expect(await read(second)).toContain('Synthetic answer: Banana question')
        expect((await list(bob.id)).map(s => s.id)).toEqual([other])
        expect(await read(other)).not.toMatch(/Apple|Banana/)
    } finally {
        await closeDesktopDatabase(root)
        if (server?.listening) await stopEngine()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
})
