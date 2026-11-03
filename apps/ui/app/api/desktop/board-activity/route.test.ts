import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as readBoardActivity } from './route'

const originalEnv = { ...process.env }
const sessionToken = 'b'.repeat(48)
let root: string
let server: Server
// Engine-side runs keyed by engine agent id; `null` makes that agent's read fail.
let runs: Record<string, { id: string; status: string }[] | null>
const seen: string[] = []

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-board-activity-'))
    runs = {}
    seen.length = 0
    server = createServer((req, res) => {
        const match = /^\/agents\/([^/]+)\/runs(\?.*)?$/.exec(req.url ?? '')
        if (req.method === 'GET' && match) {
            seen.push(req.url!)
            const list = runs[decodeURIComponent(match[1])]
            if (list === null || list === undefined) return res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'down' }))
            const status = new URLSearchParams(match[2] ?? '').get('status')
            const filtered = list.filter(run => !status || run.status === status).map(run => ({
                id: run.id, agentId: match[1], sessionId: 's', status: run.status, stepCount: 0, usageJson: null, provider: null, model: null, triggerSource: 'chat', triggerSlug: null,
                costMicros: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, error: null,
            }))
            return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ runs: filtered }))
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
        protocolVersion: 1, launchNonce: 'board-launch', buildId: 'board-build', workspaceId: 1, dataRoot: root,
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

const request = (cookie = `rerun-desktop-session=${sessionToken}`) => new Request('http://127.0.0.1:3100/api/desktop/board-activity', { headers: { host: '127.0.0.1:3100', cookie } })

async function twoCoworkers() {
    const db = await openDesktopDatabase(root)
    const researcher = await createDesktopAgent(db, { engineAgentId: 'engine-researcher', name: 'Researcher' })
    const reviewer = await createDesktopAgent(db, { engineAgentId: 'engine-reviewer', name: 'Reviewer' })
    return { researcher, reviewer }
}

describe('GET /api/desktop/board-activity', () => {
    it('marks only the coworker with a running run as working, mapped by local id', async () => {
        const { researcher, reviewer } = await twoCoworkers()
        runs = { 'engine-researcher': [{ id: 'r1', status: 'running' }], 'engine-reviewer': [{ id: 'r2', status: 'completed' }] }
        const response = await readBoardActivity(request())
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.agents).toEqual({ [researcher.id]: 'working', [reviewer.id]: 'idle' })
        expect(JSON.stringify(body)).not.toContain('engine-')
        expect(seen.every(url => url.includes('status=running'))).toBe(true)

        runs['engine-researcher'] = [{ id: 'r1', status: 'completed' }]
        expect((await (await readBoardActivity(request())).json()).agents).toEqual({ [researcher.id]: 'idle', [reviewer.id]: 'idle' })
    })

    it('reports a failed engine read as unreachable rather than idle', async () => {
        const { researcher, reviewer } = await twoCoworkers()
        runs = { 'engine-researcher': [], 'engine-reviewer': null }
        const body = await (await readBoardActivity(request())).json()
        expect(body.agents).toEqual({ [researcher.id]: 'idle', [reviewer.id]: 'unreachable' })
    })

    it('requires the local desktop session', async () => {
        await twoCoworkers()
        expect((await readBoardActivity(request('rerun-desktop-session=wrong'))).status).toBe(401)
        expect(seen).toEqual([])
    })
})
