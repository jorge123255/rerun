import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Run } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET } from './route'

const originalEnv = { ...process.env }
let root: string, server: Server, alice: string, bob: string
let reply: unknown, status: number
const requests: string[] = []
export const recordedRun = (): Run => ({ id: 'run-1', agentId: 'engine-alice', sessionId: 'private-engine-session', status: 'running', startedAt: '2026-11-03T12:00:00.000Z', finishedAt: null,
    stepCount: 0, usageJson: null, provider: 'openrouter', model: 'local-test', triggerSource: 'dashboard', triggerSlug: null,
    inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: null, error: null })
const request = (id: string) => new Request(`http://127.0.0.1:3189/api/desktop/agents/${id}/runs`, { headers: { host: '127.0.0.1:3189', cookie: `rerun-desktop-session=${'r'.repeat(48)}` } })
const get = (id: string, req = request(id)) => GET(req, { params: Promise.resolve({ agentId: id }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-runs-route-'))
    requests.length = 0
    status = 200
    reply = { runs: [recordedRun()] }
    server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`)
        expect(req.headers.authorization).toBe('Bearer fixture-engine')
        const body = req.url?.startsWith('/agents/engine-bob/') ? { runs: [] } : reply
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test engine address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'runs-route', buildId: 'runs-test', workspaceId: 1, dataRoot: root,
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

test('maps the local coworker server-side and returns only list fields using one bounded read', async () => {
    reply = { runs: Array.from({ length: 100 }, (_, i) => ({ ...recordedRun(), id: `run-${i + 1}` })) }
    const response = await get(alice)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.runs).toHaveLength(100)
    expect(body.runs[99].id).toBe('run-100')
    expect(body.runs[0]).toMatchObject({ id: 'run-1', status: 'running', startedAt: recordedRun().startedAt, finishedAt: null,
        triggerSource: 'dashboard', triggerSlug: null })
    expect(body.runs[0]).not.toHaveProperty('agentId')
    expect(body.runs[0]).not.toHaveProperty('sessionId')
    expect(body.runs[0]).not.toHaveProperty('usageJson')
    expect(requests).toEqual(['GET /agents/engine-alice/runs?limit=100'])
})
test('keeps another coworker empty and rejects engine IDs as local coworker IDs', async () => {
    expect(await (await get(bob)).json()).toEqual({ runs: [] })
    expect((await get('engine-alice')).status).toBe(404)
    expect(requests).toEqual(['GET /agents/engine-bob/runs?limit=100'])
})
test('requires the local session and rejects foreign hosts and cross-site requests before contacting the engine', async () => {
    const anonymous = request(alice); anonymous.headers.delete('cookie')
    expect((await get(alice, anonymous)).status).toBe(401)
    const foreign = request(alice); foreign.headers.set('host', 'example.invalid')
    expect((await get(alice, foreign)).status).toBe(403)
    const crossSite = request(alice); crossSite.headers.set('sec-fetch-site', 'cross-site')
    expect((await get(alice, crossSite)).status).toBe(403)
    expect(requests).toEqual([])
})
test('distinguishes empty reads from failed and malformed engine responses without exposing engine errors', async () => {
    reply = { runs: [] }
    expect(await (await get(alice)).json()).toEqual({ runs: [] })
    status = 503; reply = { error: 'fixture-private-details' }
    const failed = await get(alice)
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain('fixture-private-details')
    status = 200; reply = { runs: [{ id: 'incomplete' }] }
    expect((await get(alice)).status).toBe(502)
})
test('fails closed if the engine supplies another coworker’s records', async () => {
    reply = { runs: [{ ...recordedRun(), agentId: 'engine-bob' }] }
    expect((await get(alice)).status).toBe(502)
})
test('reads current terminal times and usage and keeps the same entry after reopening the local database', async () => {
    const done = { ...recordedRun(), status: 'done', stepCount: 1, finishedAt: '2026-11-03T12:00:03.000Z', inputTokens: 12, outputTokens: 4, totalTokens: 16 }
    reply = { runs: [done] }
    const before = await (await get(alice)).json()
    expect(before.runs[0]).toMatchObject({ status: 'done', inputTokens: 12, outputTokens: 4, totalTokens: 16, finishedAt: done.finishedAt })
    await closeDesktopDatabase(root)
    expect(await (await get(alice)).json()).toEqual(before)
})
