import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { GET as readBoardActivity } from '../../../board-activity/route'
import { GET as readStop, POST as stop } from './route'

const originalEnv = { ...process.env }
const sessionToken = 'c'.repeat(48)
const origin = 'http://127.0.0.1:3100'
type Run = { id: string; agentId: string; sessionId: string; status: string }
let root: string
let server: Server
// A controllable engine: runs stay "running" (held) until canceled or finished by the test.
let runs: Run[]
let listFails: boolean
let cancelFails: Set<string>
let ignoreFilters: boolean
const cancels: string[] = []

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-stop-turn-'))
    runs = []
    listFails = false
    cancelFails = new Set()
    ignoreFilters = false
    cancels.length = 0
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://engine')
        const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        // Board attention now verifies that a stopped chat has no pending request.
        const messages = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
        if (req.method === 'GET' && messages) {
            const owned = runs.some(run => run.agentId === decodeURIComponent(messages[1]) && run.sessionId === decodeURIComponent(messages[2]))
            return owned ? json(200, { messages: [] }) : json(404, { error: 'conversation not found' })
        }
        const list = /^\/agents\/([^/]+)\/runs$/.exec(url.pathname)
        if (req.method === 'GET' && list) {
            if (listFails) return json(503, { error: 'down' })
            const agentId = decodeURIComponent(list[1])
            const session = url.searchParams.get('session')
            const status = url.searchParams.get('status')
            const filtered = ignoreFilters ? runs : runs.filter(run => run.agentId === agentId && (!session || run.sessionId === session) && (!status || run.status === status))
            return json(200, { runs: filtered.map(run => ({
                ...run, stepCount: 0, usageJson: null, provider: 'local', model: 'local-model', triggerSource: 'chat', triggerSlug: null,
                costMicros: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null,
                startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, error: null,
            })) })
        }
        const cancel = /^\/agents\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(url.pathname)
        if (req.method === 'POST' && cancel) {
            const id = decodeURIComponent(cancel[2])
            cancels.push(`${decodeURIComponent(cancel[1])}/${id}`)
            if (cancelFails.has(id)) return json(500, { error: 'boom' })
            const run = runs.find(r => r.id === id && r.agentId === decodeURIComponent(cancel[1]))
            if (!run) return json(404, { error: 'run not found' })
            if (run.status !== 'running') return json(409, { error: 'run is not running' })
            run.status = 'cancelled'
            return json(200, { ok: true })
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
        protocolVersion: 1, launchNonce: 'stop-launch', buildId: 'stop-build', workspaceId: 1, dataRoot: root,
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
const post = (id: string, headers: Record<string, string> = { origin, cookie }) => stop(
    new Request(`${origin}/api/desktop/sessions/${id}/stop`, { method: 'POST', headers: { host: '127.0.0.1:3100', ...headers } }),
    { params: Promise.resolve({ sessionId: id }) },
)
const get = (id: string) => readStop(
    new Request(`${origin}/api/desktop/sessions/${id}/stop`, { headers: { host: '127.0.0.1:3100', cookie } }),
    { params: Promise.resolve({ sessionId: id }) },
)
const board = async () => (await (await readBoardActivity(new Request(`${origin}/api/desktop/board-activity`, { headers: { host: '127.0.0.1:3100', cookie } }))).json()).agents

// Two coworkers, each with a held turn in its own conversation.
async function twoHeldTurns() {
    const db = await openDesktopDatabase(root)
    const researcher = await createDesktopAgent(db, { engineAgentId: 'engine-researcher', name: 'Researcher' })
    const reviewer = await createDesktopAgent(db, { engineAgentId: 'engine-reviewer', name: 'Reviewer' })
    const a = await createDesktopSession(db, { agentId: researcher.id, engineSessionId: 'es-a', title: 'A' })
    const b = await createDesktopSession(db, { agentId: reviewer.id, engineSessionId: 'es-b', title: 'B' })
    runs = [
        { id: 'run-a', agentId: 'engine-researcher', sessionId: 'es-a', status: 'running' },
        { id: 'run-b', agentId: 'engine-reviewer', sessionId: 'es-b', status: 'running' },
    ]
    return { researcher, reviewer, a, b }
}

describe('/api/desktop/sessions/[sessionId]/stop', () => {
    it('cancels only that conversation’s engine run; the other coworker keeps working', async () => {
        const { researcher, reviewer, a, b } = await twoHeldTurns()
        expect(await board()).toEqual({ [researcher.id]: 'working', [reviewer.id]: 'working' })
        expect(await (await get(a.id)).json()).toEqual({ running: true, runId: 'run-a', failedRunId: null })

        const response = await post(a.id)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ canceled: 1, alreadyFinished: false })
        expect(cancels).toEqual(['engine-researcher/run-a'])
        expect(runs.find(r => r.id === 'run-a')!.status).toBe('cancelled')
        expect(runs.find(r => r.id === 'run-b')!.status).toBe('running')
        expect(await board()).toEqual({ [researcher.id]: 'idle', [reviewer.id]: 'working' })
        expect(await (await get(a.id)).json()).toEqual({ running: false, runId: null, failedRunId: null })
        expect(await (await get(b.id)).json()).toEqual({ running: true, runId: 'run-b', failedRunId: null })

        // A follow-up turn in the canceled conversation is a new run that can itself be stopped.
        runs.push({ id: 'run-a2', agentId: 'engine-researcher', sessionId: 'es-a', status: 'running' })
        expect(await (await get(a.id)).json()).toEqual({ running: true, runId: 'run-a2', failedRunId: null })
        expect(await (await post(a.id)).json()).toEqual({ canceled: 1, alreadyFinished: false })
        expect(runs.find(r => r.id === 'run-b')!.status).toBe('running')
    })

    it('reports an already finished reply honestly and idempotently', async () => {
        const { a } = await twoHeldTurns()
        runs[0].status = 'done'
        const response = await post(a.id)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ canceled: 0, alreadyFinished: true })
        expect(cancels).toEqual([])
    })

    it('treats a run that finishes between list and cancel as already finished', async () => {
        const { a } = await twoHeldTurns()
        cancelFails.clear()
        // Engine reports running, but the cancel answers 409 because it just finished.
        const original = runs[0]
        server.prependListener('request', req => { if (req.method === 'POST') original.status = 'done' })
        expect(await (await post(a.id)).json()).toEqual({ canceled: 0, alreadyFinished: true })
    })

    it('never cancels runs from another session, status or coworker even if the engine ignores filters', async () => {
        const { a } = await twoHeldTurns()
        ignoreFilters = true
        runs.push(
            { id: 'other-session', agentId: 'engine-researcher', sessionId: 'es-x', status: 'running' },
            { id: 'done', agentId: 'engine-researcher', sessionId: 'es-a', status: 'done' },
        )
        await post(a.id)
        expect(cancels).toEqual(['engine-researcher/run-a'])
    })

    it('surfaces cancel and read failures without claiming success', async () => {
        const { a } = await twoHeldTurns()
        cancelFails.add('run-a')
        const failed = await post(a.id)
        expect(failed.status).toBe(502)
        expect((await failed.json()).error).toMatch(/could not stop/i)
        expect(runs[0].status).toBe('running')
        listFails = true
        expect((await post(a.id)).status).toBe(502)
        expect((await get(a.id)).status).toBe(502)
    })

    it('returns 404 for a stale or unknown conversation without touching the engine', async () => {
        await twoHeldTurns()
        const response = await post('no-such-session')
        expect(response.status).toBe(404)
        expect((await response.json()).error).toBe('Conversation not found')
        expect((await get('no-such-session')).status).toBe(404)
        expect(cancels).toEqual([])
    })

    it('requires the local desktop session and same origin', async () => {
        const { a } = await twoHeldTurns()
        expect((await post(a.id, { origin, cookie: 'rerun-desktop-session=wrong' })).status).toBe(401)
        expect((await post(a.id, { origin: 'http://evil.test', cookie })).status).toBe(403)
        expect(cancels).toEqual([])
    })
})
