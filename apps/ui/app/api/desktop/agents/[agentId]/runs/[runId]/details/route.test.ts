import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { RunStep, ToolCall } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET } from './route'

const originalEnv = { ...process.env }
let root: string, server: Server, alice: string, bob: string
let steps: RunStep[], tools: ToolCall[], status: number
const seen: string[] = []
const request = (agentId: string) => new Request(`http://127.0.0.1:3189/api/desktop/agents/${agentId}/runs/run-1/details`, { headers: { host: '127.0.0.1:3189', cookie: `rerun-desktop-session=${'r'.repeat(48)}` } })
const get = (agentId: string, req = request(agentId), runId = 'run-1') => GET(req, { params: Promise.resolve({ agentId, runId }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-details-route-'))
    status = 200; seen.length = 0
    steps = [{ id: 'step-1', runId: 'run-1', agentId: 'engine-alice', sessionId: 'engine-session', stepNumber: 1, provider: 'openrouter', model: 'qa', finishReason: 'tool-calls', inputTokens: 12, outputTokens: 4, cachedInputTokens: null, reasoningTokens: null, totalTokens: 16, toolCallCount: 1, textLength: 0, durationMs: 100, createdAt: '2026-11-03T12:00:00.000Z' }]
    tools = [{ id: 'tool-1', runId: 'run-1', agentId: 'engine-alice', sessionId: 'engine-session', stepNumber: 1, toolCallId: 'call-1', toolName: 'fixture_lookup', inputJson: '{"private-input":true}', resultJson: '{"answer":"Recorded answer"}', isError: 0, durationMs: 0, createdAt: '2026-11-03T12:00:00.000Z' }]
    server = createServer((req, res) => {
        seen.push(req.url!)
        expect(req.headers.authorization).toBe('Bearer details-engine')
        if (!req.url?.startsWith('/agents/engine-alice/runs/run-1/')) return res.writeHead(404).end()
        const value = status !== 200 ? { error: 'fixture-private-details' } : req.url.endsWith('/steps') ? { steps } : { tools }
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'details', buildId: 'details-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3189', sessionToken: 'r'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'details-engine' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' })).id
    bob = (await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })).id
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    await new Promise<void>(resolve => server.close(() => resolve()))
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('reads scoped steps and tools through existing clients and projects only the detail view', async () => {
    const response = await get(alice)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.steps[0]).toMatchObject({ stepNumber: 1, finishReason: 'tool-calls', totalTokens: 16 })
    expect(body.tools[0]).toMatchObject({ toolName: 'fixture_lookup', isError: 0, resultJson: JSON.stringify('Tool completed.') })
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/engine-alice|engine-session|private-input|call-1/)
    expect(seen.sort()).toEqual(['/agents/engine-alice/runs/run-1/steps', '/agents/engine-alice/runs/run-1/tools'])
})
test('cannot open another coworker’s run or use an engine ID as a local ID', async () => {
    expect((await get(bob)).status).toBe(404)
    expect((await get('engine-alice')).status).toBe(404)
    expect(seen.every(path => path.startsWith('/agents/engine-bob/'))).toBe(true)
})
test('authenticates before lookup or engine access', async () => {
    const anonymous = request(alice); anonymous.headers.delete('cookie')
    expect((await get(alice, anonymous)).status).toBe(401)
    const foreign = request(alice); foreign.headers.set('host', 'example.invalid')
    expect((await get(alice, foreign)).status).toBe(403)
    const crossSite = request(alice); crossSite.headers.set('sec-fetch-site', 'cross-site')
    expect((await get(alice, crossSite)).status).toBe(403)
    expect(seen).toEqual([])
})
test('distinguishes no recorded details, a missing run, and a failed read', async () => {
    steps = []; tools = []
    expect(await (await get(alice)).json()).toEqual({ steps: [], tools: [] })
    expect((await get(alice, request(alice), 'unknown-run')).status).toBe(404)
    status = 503
    const response = await get(alice)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('fixture-private-details')
})
test('fails closed for mismatched run or coworker records and malformed telemetry', async () => {
    tools[0].runId = 'other-run'
    expect((await get(alice)).status).toBe(502)
    tools = []; steps[0].agentId = 'engine-bob'
    expect((await get(alice)).status).toBe(502)
    steps = [{ id: 'malformed' } as RunStep]
    expect((await get(alice)).status).toBe(502)
})
