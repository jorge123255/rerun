import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { GET as readMessages } from '../messages/route'
import { GET as resume } from './route'

const originalEnv = { ...process.env }
const sessionToken = 'd'.repeat(48)
const origin = 'http://127.0.0.1:3100'
type Run = { id: string; agentId: string; sessionId: string; status: string; error?: string | null; startedAt: string }
let root: string
let server: Server
let runs: Run[]
const chats: string[] = []
const streams: string[] = []

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-chat-resume-'))
    runs = []
    chats.length = 0
    streams.length = 0
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://engine')
        const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (req.method === 'POST' && url.pathname.includes('/chat')) {
            chats.push(url.pathname)
            return json(500, { error: 'resume must not send' })
        }
        const messages = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
        if (req.method === 'GET' && messages) return json(200, { messages: [{ id: 'user-1', sessionId: decodeURIComponent(messages[2]), role: 'user', contentJson: JSON.stringify([{ type: 'text', text: 'hello' }]), toolCallsJson: null, createdAt: '2026-11-06T00:00:00.000Z' }] })
        const list = /^\/agents\/([^/]+)\/runs$/.exec(url.pathname)
        if (req.method === 'GET' && list) {
            const agentId = decodeURIComponent(list[1])
            const session = url.searchParams.get('session')
            const filtered = runs.filter(run => run.agentId === agentId && (!session || run.sessionId === session))
            return json(200, { runs: filtered.map(run => ({
                ...run, stepCount: 0, usageJson: null, provider: 'local', model: 'local-model', triggerSource: 'chat', triggerSlug: null,
                costMicros: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null,
                finishedAt: null, error: run.error ?? null,
            })) })
        }
        const stream = /^\/agents\/([^/]+)\/runs\/([^/]+)\/stream$/.exec(url.pathname)
        if (req.method === 'GET' && stream) {
            const id = decodeURIComponent(stream[2])
            streams.push(`${decodeURIComponent(stream[1])}/${id}`)
            const run = runs.find(item => item.id === id)
            if (!run || run.status !== 'running') return res.writeHead(204).end()
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' })
            res.end('data: {"type":"text-delta"}\n\n')
            return
        }
        json(404, { error: 'not found' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test engine address')
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_SECRET_KEY = 'cd'.repeat(32)
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'resume-launch', buildId: 'resume-build', workspaceId: 1, dataRoot: root,
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
const headers = { host: '127.0.0.1:3100', origin, cookie }

async function conversation() {
    const db = await openDesktopDatabase(root)
    const agent = await createDesktopAgent(db, { engineAgentId: 'engine-owner', name: 'Owner' })
    const session = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-session', title: 'Chat' })
    const other = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-other', title: 'Other' })
    return { agent, session, other }
}

describe('desktop chat resume', () => {
    it('streams the live run and does not start another chat', async () => {
        const { session } = await conversation()
        runs = [{ id: 'live', agentId: 'engine-owner', sessionId: 'engine-session', status: 'running', startedAt: '2026-11-06T00:02:00.000Z' }]
        const response = await resume(new Request(`${origin}/api/desktop/sessions/${session.id}/resume?runId=live`, { headers }), { params: Promise.resolve({ sessionId: session.id }) })
        expect(response.status).toBe(200)
        expect(response.headers.get('x-rerun-resume')).toBe('streaming')
        expect(response.headers.get('x-session-id')).toBeNull()
        expect(await response.text()).toContain('text-delta')
        expect(streams).toEqual(['engine-owner/live'])
        expect(chats).toEqual([])
    })

    it('reports a finished or foreign run as unavailable and does not send', async () => {
        const { session, other } = await conversation()
        runs = [{ id: 'done', agentId: 'engine-owner', sessionId: 'engine-session', status: 'done', startedAt: '2026-11-06T00:02:00.000Z' }]
        const finished = await resume(new Request(`${origin}/api/desktop/sessions/${session.id}/resume?runId=done`, { headers }), { params: Promise.resolve({ sessionId: session.id }) })
        expect(finished.status).toBe(204)
        expect(finished.headers.get('x-rerun-resume')).toBe('unavailable')
        expect(finished.headers.get('x-rerun-resume-reason')).toBe('not-running')
        const foreign = await resume(new Request(`${origin}/api/desktop/sessions/${other.id}/resume?runId=done`, { headers }), { params: Promise.resolve({ sessionId: other.id }) })
        expect(foreign.status).toBe(204)
        expect(foreign.headers.get('x-rerun-resume-reason')).toBe('identity')
        expect(chats).toEqual([])
        expect(streams).toEqual([])
    })

    it('replays the newest failed run beside history without calling it resumable', async () => {
        const { session } = await conversation()
        runs = [
            { id: 'old', agentId: 'engine-owner', sessionId: 'engine-session', status: 'error', error: 'older', startedAt: '2026-11-06T00:01:00.000Z' },
            { id: 'new', agentId: 'engine-owner', sessionId: 'engine-session', status: 'error', error: 'The model refused the turn.', startedAt: '2026-11-06T00:03:00.000Z' },
        ]
        const response = await readMessages(new Request(`${origin}/api/desktop/sessions/${session.id}/messages`, { headers }), { params: Promise.resolve({ sessionId: session.id }) })
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.lastError).toBe('The model refused the turn.')
        expect(body.activeRunId).toBeNull()
        expect(body.runsUnavailable).toBe(false)
        expect(body.messages).toEqual([expect.objectContaining({ role: 'user' })])
        const resumeResponse = await resume(new Request(`${origin}/api/desktop/sessions/${session.id}/resume?runId=new`, { headers }), { params: Promise.resolve({ sessionId: session.id }) })
        expect(resumeResponse.status).toBe(204)
        expect(chats).toEqual([])
    })
})
