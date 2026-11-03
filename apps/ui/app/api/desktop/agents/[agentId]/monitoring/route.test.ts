import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { StatsPoint } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET } from './route'

const originalEnv = { ...process.env }
let root: string, server: Server, alice: string, bob: string
let status: number
let replies: Record<string, StatsPoint[]>
const requests: string[] = []

const point = (value: number, count: number, group: string | null = null, bucket = '2026-11-03'): StatsPoint => ({ bucket, group, value, count })
const defaults = (): Record<string, StatsPoint[]> => ({
    'count:none': [point(2, 2)],
    'errorRate:none': [point(0.25, 2)],
    'count:status': [point(1, 1, 'done'), point(1, 1, 'error')],
    'count:model': [point(2, 2, 'local-test')],
    'totalTokens:none': [point(320, 2)],
    'recordedTokenRuns:none': [point(2, 2)],
    'cost:none': [point(500, 2)],
    'recordedCostRuns:none': [point(2, 2)],
})

const request = (id: string, range?: string) => new Request(`http://127.0.0.1:3189/api/desktop/agents/${id}/monitoring${range ? `?range=${range}` : ''}`, { headers: { host: '127.0.0.1:3189', cookie: `rerun-desktop-session=${'r'.repeat(48)}` } })
const get = (id: string, req = request(id)) => GET(req, { params: Promise.resolve({ agentId: id }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-monitoring-route-'))
    requests.length = 0
    status = 200
    replies = defaults()
    server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`)
        expect(req.headers.authorization).toBe('Bearer fixture-engine')
        const url = new URL(req.url!, 'http://engine.test')
        const key = `${url.searchParams.get('metric')}:${url.searchParams.get('groupBy')}`
        const body = url.pathname.startsWith('/agents/engine-bob/') ? { points: [] } : { points: replies[key] ?? [] }
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? body : { error: 'fixture-private-details' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test engine address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'monitoring-route', buildId: 'monitoring-test', workspaceId: 1, dataRoot: root,
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

const statsCalls = () => requests.map(line => line.split(' ')[1].split('?')[1]).map(qs => `${new URLSearchParams(qs).get('metric')}:${new URLSearchParams(qs).get('groupBy')}`)

test('maps the local coworker server-side and issues exactly eight runs stats reads for the range', async () => {
    const response = await get(alice)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.agentId).toBe(alice)
    expect(body.range).toBe('7d')
    expect(body.runs).toEqual(defaults()['count:none'])
    expect(body.totalTokens).toEqual(defaults()['totalTokens:none'])
    expect(body.cost).toEqual(defaults()['cost:none'])
    expect(requests.every(line => line.startsWith('GET /agents/engine-alice/stats?'))).toBe(true)
    expect(requests.every(line => line.includes('dataset=runs') && line.includes('range=7d'))).toBe(true)
    expect(statsCalls().sort()).toEqual([
        'count:model', 'count:none', 'count:status', 'cost:none', 'errorRate:none', 'recordedCostRuns:none', 'recordedTokenRuns:none', 'totalTokens:none',
    ].sort())
    expect(requests.some(line => line.includes('/usage') || line.includes('/chat'))).toBe(false)
})

test('passes the requested 90d range through to every engine read', async () => {
    const response = await get(alice, request(alice, '90d'))
    expect((await response.json()).range).toBe('90d')
    expect(requests).toHaveLength(8)
    expect(requests.every(line => line.includes('range=90d'))).toBe(true)
})

test('rejects unknown ranges and engine IDs as local coworker IDs before contacting the engine', async () => {
    expect((await get(alice, request(alice, 'all'))).status).toBe(400)
    expect((await get(alice, request(alice, '1y'))).status).toBe(400)
    expect((await get('engine-alice')).status).toBe(404)
    expect(requests).toEqual([])
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

test('keeps another coworker scoped to its own engine stats', async () => {
    const body = await (await get(bob)).json()
    expect(body.agentId).toBe(bob)
    expect(body.runs).toEqual([])
    expect(body.totalTokens).toBeNull()
    expect(body.cost).toBeNull()
    expect(requests.every(line => line.startsWith('GET /agents/engine-bob/stats?'))).toBe(true)
})

test('hides total tokens unless every run in the window recorded them', async () => {
    replies['count:none'].push(point(3, 3, null, '2026-11-04'))
    replies['totalTokens:none'].push(point(15, 3, null, '2026-11-04'))
    replies['recordedTokenRuns:none'] = [point(2, 2), point(1, 3, null, '2026-11-04')]
    const partial = await (await get(alice)).json()
    expect(partial.totalTokens).toBeNull()
    replies['recordedTokenRuns:none'] = [point(2, 2), point(3, 3, null, '2026-11-04')]
    const covered = await (await get(alice)).json()
    expect(covered.totalTokens).toEqual(replies['totalTokens:none'])
})

test('shows measured zero cost and hides missing cost', async () => {
    replies['recordedCostRuns:none'] = [point(1, 2)]
    expect((await (await get(alice)).json()).cost).toBeNull()
    replies['recordedCostRuns:none'] = [point(2, 2)]
    replies['cost:none'] = [point(0, 2)]
    expect((await (await get(alice)).json()).cost).toEqual([point(0, 2)])
    replies['cost:none'] = [point(40, 2)]
    expect((await (await get(alice)).json()).cost).toEqual([point(40, 2)])
})

test('withholds a total when coverage and values were read across different run counts or dates', async () => {
    replies['totalTokens:none'] = [point(320, 3)]
    expect((await (await get(alice)).json()).totalTokens).toBeNull()
    replies['recordedCostRuns:none'] = [point(2, 2, null, '2026-11-04')]
    expect((await (await get(alice)).json()).cost).toBeNull()
    replies['count:none'].push(point(1, 1, null, '2026-11-04'))
    replies['totalTokens:none'] = [point(320, 2)]
    expect((await (await get(alice)).json()).totalTokens).toBeNull()
})

test('maps engine failure and malformed replies to 502 without leaking engine text', async () => {
    status = 503
    const failed = await get(alice)
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain('fixture-private-details')
    status = 200
    replies['count:none'] = [{ broken: true } as unknown as StatsPoint]
    expect((await get(alice)).status).toBe(502)
})
