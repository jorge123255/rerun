import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MESSAGE_FEEDBACK_CATEGORIES } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { DELETE, GET, PATCH, PUT } from './route'

const originalEnv = { ...process.env }
const sessionToken = 'd'.repeat(48)
const origin = 'http://127.0.0.1:3101'
const answer = 'Shared answer'
let root: string
let server: Server
let failReads = false
const calls: string[] = []
const transcripts = new Map<string, unknown[]>()

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-reply-feedback-'))
    failReads = false
    calls.length = 0
    transcripts.clear()
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://engine')
        calls.push(`${req.method} ${url.pathname}`)
        const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
        if (req.method === 'GET' && match) {
            if (failReads) return json(503, { error: 'down' })
            const key = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`
            return json(200, { messages: transcripts.get(key) ?? [] })
        }
        json(404, { error: 'not found' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test engine address')
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'feedback-launch', buildId: 'feedback-build', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken },
        engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'engine-secret' },
    }), { mode: 0o600 })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

const cookie = `rerun-desktop-session=${sessionToken}`
const headers = { host: '127.0.0.1:3101', origin, cookie, 'content-type': 'application/json' }
const params = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) })
const saved = (id: string, sessionId: string, role: 'assistant' | 'user', text = answer) => ({
    id, sessionId, role, contentJson: JSON.stringify([{ type: 'text', text }]), toolCallsJson: null, createdAt: '2026-01-01T00:00:00.000Z',
})

async function workspace() {
    const db = await openDesktopDatabase(root)
    const ada = await createDesktopAgent(db, { engineAgentId: 'engine-ada', name: 'Ada' })
    const bea = await createDesktopAgent(db, { engineAgentId: 'engine-bea', name: 'Bea' })
    const first = await createDesktopSession(db, { agentId: ada.id, engineSessionId: 'engine-session-1', title: 'First' })
    const second = await createDesktopSession(db, { agentId: ada.id, engineSessionId: 'engine-session-2', title: 'Second' })
    const other = await createDesktopSession(db, { agentId: bea.id, engineSessionId: 'engine-session-3', title: 'Other' })
    transcripts.set('engine-ada/engine-session-1', [saved('msg-a', 'engine-session-1', 'user', 'Question'), saved('msg-a-reply', 'engine-session-1', 'assistant')])
    transcripts.set('engine-ada/engine-session-2', [saved('msg-b-reply', 'engine-session-2', 'assistant')])
    transcripts.set('engine-bea/engine-session-3', [saved('msg-c-reply', 'engine-session-3', 'assistant')])
    return { ada, bea, first, second, other }
}

async function rows() {
    const db = await openDesktopDatabase(root)
    const result = await db.execute('SELECT agent_id, session_id, message_id, rating, category, details FROM desktop_message_feedback ORDER BY message_id')
    return result.rows
}

const put = (sessionId: string, body: unknown) => PUT(new Request(`${origin}/api/desktop/sessions/${sessionId}/feedback`, { method: 'PUT', headers, body: JSON.stringify(body) }), params(sessionId))
const patch = (sessionId: string, body: unknown) => PATCH(new Request(`${origin}/api/desktop/sessions/${sessionId}/feedback`, { method: 'PATCH', headers, body: JSON.stringify(body) }), params(sessionId))
const remove = (sessionId: string, agentId: string, id: string) => DELETE(new Request(`${origin}/api/desktop/sessions/${sessionId}/feedback?agentId=${agentId}&id=${id}`, { method: 'DELETE', headers }), params(sessionId))
const list = (sessionId: string, agentId: string) => GET(new Request(`${origin}/api/desktop/sessions/${sessionId}/feedback?agentId=${agentId}`, { headers }), params(sessionId))

describe('desktop reply feedback', () => {
    it('keeps a vote on one saved reply when another chat and coworker use the same answer', async () => {
        const { ada, bea, first, second, other } = await workspace()
        const voted = await put(first.id, { agentId: ada.id, messageId: 'engine-msg-a-reply', rating: 'up' })
        expect(voted.status).toBe(200)
        const vote = await voted.json()
        expect(vote).toMatchObject({ messageId: 'engine-msg-a-reply', rating: 'up' })
        expect(await rows()).toEqual([{ agent_id: ada.id, session_id: first.id, message_id: 'engine-msg-a-reply', rating: 'up', category: null, details: null }])

        expect((await put(second.id, { agentId: ada.id, messageId: 'engine-msg-a-reply', rating: 'down' })).status).toBe(404)
        expect((await put(other.id, { agentId: bea.id, messageId: 'engine-msg-a-reply', rating: 'down' })).status).toBe(404)
        expect((await put(first.id, { agentId: bea.id, messageId: 'engine-msg-a-reply', rating: 'down' })).status).toBe(404)
        expect((await put(first.id, { agentId: ada.id, messageId: 'engine-msg-a', rating: 'up' })).status).toBe(404)
        expect(await rows()).toHaveLength(1)
        expect((await list(second.id, ada.id)).status).toBe(200)
        expect(await (await list(second.id, ada.id)).json()).toEqual({ votes: [] })
        expect(await (await list(other.id, bea.id)).json()).toEqual({ votes: [] })
        expect(calls.every(call => call.startsWith('GET /agents/') && call.endsWith('/messages'))).toBe(true)

        const noted = await patch(first.id, { agentId: ada.id, id: vote.id, category: 'not_factual', details: '  Wrong date  ' })
        expect(noted.status).toBe(200)
        expect(await rows()).toEqual([{ agent_id: ada.id, session_id: first.id, message_id: 'engine-msg-a-reply', rating: 'up', category: 'not_factual', details: 'Wrong date' }])
        expect((await patch(other.id, { agentId: bea.id, id: vote.id, category: 'other', details: 'nope' })).status).toBe(404)
        expect((await patch(first.id, { agentId: ada.id, id: vote.id, category: 'rude', details: '' })).status).toBe(400)
        expect((await patch(first.id, { agentId: ada.id, id: vote.id, category: 'other', details: 'x'.repeat(5_001) })).status).toBe(400)
        expect(await rows()).toEqual([{ agent_id: ada.id, session_id: first.id, message_id: 'engine-msg-a-reply', rating: 'up', category: 'not_factual', details: 'Wrong date' }])

        const switched = await put(first.id, { agentId: ada.id, messageId: 'engine-msg-a-reply', rating: 'down' })
        expect(await switched.json()).toMatchObject({ id: vote.id, rating: 'down' })
        expect(await rows()).toEqual([{ agent_id: ada.id, session_id: first.id, message_id: 'engine-msg-a-reply', rating: 'down', category: null, details: null }])
        expect(MESSAGE_FEEDBACK_CATEGORIES.map(category => category.value)).toContain('not_factual')

        await closeDesktopDatabase(root)
        expect(await (await list(first.id, ada.id)).json()).toEqual({ votes: [{ id: vote.id, messageId: 'engine-msg-a-reply', rating: 'down' }] })
        expect((await remove(first.id, ada.id, vote.id)).status).toBe(200)
        await closeDesktopDatabase(root)
        expect(await rows()).toEqual([])
        expect(await (await list(first.id, ada.id)).json()).toEqual({ votes: [] })
    })

    it('writes nothing when the reply cannot be checked, then keeps a retry', async () => {
        const { ada, first } = await workspace()
        failReads = true
        expect((await put(first.id, { agentId: ada.id, messageId: 'engine-msg-a-reply', rating: 'up' })).status).toBe(502)
        expect(await rows()).toEqual([])
        failReads = false
        expect((await put(first.id, { agentId: ada.id, messageId: 'engine-msg-a-reply', rating: 'up' })).status).toBe(200)
        expect(await rows()).toMatchObject([{ rating: 'up', category: null, details: null }])
        expect(calls.some(call => call.includes('/chat'))).toBe(false)
    })
})
