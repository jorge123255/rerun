import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { completionIdentityOf, desktopCompletionsSchema } from '@/lib/desktop/completed-actions'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import type { EngineRunCompletion } from '@/lib/engine/client'
import { GET } from './route'
import { POST } from './read/route'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime
let alice: DesktopAgent, bob: DesktopAgent, a1: DesktopSession, a2: DesktopSession, b1: DesktopSession
let beforeReply: (() => Promise<void>) | undefined
const rows: EngineRunCompletion[] = [], calls: URL[] = [], failed = new Set<string>()
const at = (n: number) => new Date(Date.UTC(2100, 0, 1, 0, 0, n)).toISOString()
function completion(agent: DesktopAgent, session: DesktopSession, id: string, n: number): EngineRunCompletion {
    const row: EngineRunCompletion = { id, runId: id, agentId: agent.engineAgentId, sessionId: session.engineSessionId,
        source: 'chat', slug: null, completedAt: at(n), text: `Answer ${id}`, provider: 'codex', model: 'fixture', costMicros: null, stepCount: 1 }
    rows.push(row); return row
}
const identity = (agent: DesktopAgent, row: EngineRunCompletion) => completionIdentityOf({ agentId: agent.id, engineAgentId: agent.engineAgentId, engineSessionId: row.sessionId, terminalId: row.id })
function request(path = '', body?: unknown) {
    return new Request(`${runtime.app.origin}/api/desktop/completions${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { host: new URL(runtime.app.origin).host,
            origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
}
const mark = (ids: string[]) => POST(request('/read', { completionIds: ids }))
async function read(query = '') {
    const response = await GET(request(query))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return desktopCompletionsSchema.parse(await response.json())
}
const seen = async () => (await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_completions_seen')).rows

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-completions-'))
    rows.length = 0; calls.length = 0; failed.clear(); beforeReply = undefined
    server = createServer((req, res) => {
        const url = new URL(req.url!, 'http://fixture'); calls.push(url)
        const owner = url.pathname.match(/^\/agents\/([^/]+)\/runs\/completions$/)?.[1]
        if (req.method !== 'GET' || !owner) { res.writeHead(404).end(); return }
        void (async () => {
            if (failed.has(owner)) { res.writeHead(503).end(); return }
            const before = url.searchParams.has('before') ? JSON.parse(url.searchParams.get('before')!) : null
            const ids: string[] | null = url.searchParams.has('ids') ? JSON.parse(url.searchParams.get('ids')!) : null
            const result = rows.filter(row => row.agentId === owner && (!ids || ids.includes(row.id)) && (!before ||
                row.completedAt < before.completedAt || (row.completedAt === before.completedAt && (row.id < before.id || (before.inclusiveId && row.id === before.id)))))
                .sort((a, b) => a.completedAt === b.completedAt ? (a.id < b.id ? 1 : a.id === b.id ? 0 : -1) : a.completedAt < b.completedAt ? 1 : -1)
                .slice(0, ids?.length ?? Number(url.searchParams.get('limit') ?? 50))
            await beforeReply?.()
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ completions: result }))
        })().catch(() => res.writeHead(500).end())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: 'completion-launch', buildId: 'completion-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3197', sessionToken: 'c'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-a' })
    bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-b' })
    a1 = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'chat-a1', title: 'First' })
    a2 = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'chat-a2', title: 'Second' })
    b1 = await createDesktopSession(db, { agentId: bob.id, engineSessionId: 'chat-b1', title: 'Bob chat' })
})

afterEach(async () => {
    vi.restoreAllMocks()
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('uses the default page rather than one group, excludes pre-activation history and preserves cutoff through restart', async () => {
    completion(alice, a1, 'first', 1); completion(alice, a2, 'second', 2)
    completion(bob, b1, 'old', 0).completedAt = '2000-01-01T00:00:00.000Z'
    const page = await read()
    expect(page.items).toHaveLength(2)
    expect(calls.every(url => url.searchParams.get('limit') === '21')).toBe(true)
    expect(page.items.every(item => item.agentId === alice.id)).toBe(true)
    await closeDesktopDatabase(root)
    expect((await read()).enabledAt).toBe(page.enabledAt)
})

test('pages raw interleaved chat rows without dropping the middle conversation or repeating a terminal', async () => {
    const newest = completion(alice, a1, 'a-new', 3), middle = completion(alice, a2, 'b-middle', 2), oldest = completion(alice, a1, 'a-old', 1)
    const ids: string[] = []
    let query = '?limit=1'
    for (let index = 0; index < 3; index++) {
        const page = await read(query)
        ids.push(...page.items.flatMap(item => item.completionIds))
        if (index < 2) { expect(page.nextCursor).not.toBeNull(); query = `?limit=1&before=${encodeURIComponent(page.nextCursor!)}` }
        else expect(page.nextCursor).toBeNull()
    }
    expect(ids).toEqual([newest, middle, oldest].map(row => identity(alice, row)))
})

test('advances through more than 100 seen rows and exposes the older unread result', async () => {
    for (let n = 101; n > 0; n--) completion(alice, a1, `run-${n}`, n)
    expect((await mark(rows.slice(0, 100).map(row => identity(alice, row)))).status).toBe(200)
    let page = await read('?limit=50')
    expect(page.items).toEqual([]); expect(page.nextCursor).not.toBeNull()
    page = await read(`?limit=50&before=${encodeURIComponent(page.nextCursor!)}`)
    expect(page.items).toEqual([]); expect(page.nextCursor).not.toBeNull()
    page = await read(`?limit=50&before=${encodeURIComponent(page.nextCursor!)}`)
    expect(page.items.flatMap(item => item.completionIds)).toEqual([identity(alice, rows[100])])
    expect(page.nextCursor).toBeNull()
})

test('keeps equal run IDs/timestamps in two owner databases distinct for paging and marking read', async () => {
    const a = completion(alice, a1, 'same__run', 1), b = completion(bob, b1, 'same__run', 1)
    const first = await read('?limit=1'), second = await read(`?limit=1&before=${encodeURIComponent(first.nextCursor!)}`)
    expect(new Set([...first.items, ...second.items].flatMap(item => item.completionIds))).toEqual(new Set([identity(alice, a), identity(bob, b)]))
    expect((await mark([identity(alice, a)])).status).toBe(200)
    expect((await read()).items.map(item => item.agentId)).toEqual([bob.id])
})

test('exact mark-read retries persist across restart and never clear a newer arrival in the same chat', async () => {
    const first = completion(alice, a1, 'first', 1), id = identity(alice, first)
    expect((await mark([id, id])).status).toBe(200)
    expect((await mark([id])).status).toBe(200)
    const next = completion(alice, a1, 'next', 2)
    await closeDesktopDatabase(root)
    expect((await read()).items.flatMap(item => item.completionIds)).toEqual([identity(alice, next)])
    expect(await seen()).toHaveLength(1)
})

test('rejects arbitrary/future IDs, changed engine/session binding and forged owners without storing receipts', async () => {
    const actual = completion(alice, a1, 'real', 1)
    expect((await mark(['real'])).status).toBe(400)
    for (const patch of [{ terminalId: 'future' }, { engineSessionId: b1.engineSessionId }, { agentId: 'foreign' }, { engineAgentId: bob.engineAgentId }]) {
        const id = completionIdentityOf({ agentId: alice.id, engineAgentId: alice.engineAgentId, engineSessionId: actual.sessionId, terminalId: actual.id, ...patch })
        expect((await mark([id])).status).toBe(404)
    }
    expect(await seen()).toEqual([])
})

test('requires authenticated same-origin reads and mutations', async () => {
    const anonymous = request(); anonymous.headers.delete('cookie')
    expect((await GET(anonymous)).status).toBe(401)
    const foreign = request('/read', { completionIds: [] }); foreign.headers.set('origin', 'https://other.invalid')
    expect((await POST(foreign)).status).toBe(403)
    expect((await POST(request('/read', { completionIds: [], agentId: alice.id }))).status).toBe(400)
    expect((await GET(request('?before=not-a-cursor'))).status).toBe(400)
    expect(calls).toEqual([])
})

test('revalidates owner deletion and engine rebinding after the network read', async () => {
    completion(alice, a1, 'real', 1)
    beforeReply = async () => { await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agents SET engine_agent_id=? WHERE id=?', args: ['replacement', alice.id] }) }
    const rebound = await read()
    expect(rebound.items).toEqual([]); expect(rebound.unavailableAgentIds).toContain(alice.id)
    beforeReply = async () => { await (await openDesktopDatabase(root)).execute({ sql: 'DELETE FROM desktop_agents WHERE id=?', args: [alice.id] }) }
    expect((await read()).items).toEqual([])
})

test('mark-read rechecks pending removal inside its final transaction and preserves other owners', async () => {
    const a = completion(alice, a1, 'real', 1), b = completion(bob, b1, 'other', 1)
    beforeReply = async () => { await (await openDesktopDatabase(root)).execute({ sql: 'INSERT OR IGNORE INTO desktop_deletions(agent_id,engine_agent_id,name) VALUES (?,?,?)', args: [alice.id, alice.engineAgentId, alice.name] }) }
    expect((await mark([identity(alice, a)])).status).toBe(503)
    expect(await seen()).toEqual([])
    beforeReply = undefined
    expect((await mark([identity(bob, b)])).status).toBe(200)
    const page = await read()
    expect(page.unavailableAgentIds).toContain(alice.id)
    expect(page.items).toEqual([])
})

test('seen rows cascade with their chat/coworker, while disabled coworkers remain readable', async () => {
    const a = completion(alice, a1, 'first', 1), b = completion(bob, b1, 'second', 2)
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled=0 WHERE id=?', args: [alice.id] })
    expect((await read()).items.find(item => item.agentId === alice.id)?.agentEnabled).toBe(false)
    expect((await mark([identity(alice, a), identity(bob, b)])).status).toBe(200)
    await db.execute({ sql: 'DELETE FROM desktop_sessions WHERE id=?', args: [a1.id] })
    expect(await seen()).toHaveLength(1)
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id=?', args: [bob.id] })
    expect(await seen()).toEqual([])
})

test('keeps partial failures explicit and an unsuccessful mark-read retryable', async () => {
    const a = completion(alice, a1, 'first', 1); completion(bob, b1, 'second', 2)
    failed.add(alice.engineAgentId)
    const page = await read()
    expect(page.items.map(item => item.agentId)).toEqual([bob.id])
    expect(page.unavailableAgentIds).toEqual([alice.id])
    expect((await mark([identity(alice, a)])).status).toBe(503)
    expect(await seen()).toEqual([])
    failed.clear()
    expect((await mark([identity(alice, a)])).status).toBe(200)
})

test('bounds the whole scan to four active engine reads, marks unstarted owners unavailable, and recovers on the next read', async () => {
    const db = await openDesktopDatabase(root)
    for (let index = 0; index < 5; index++) await createDesktopAgent(db, { name: `Extra ${index}`, engineAgentId: `extra-${index}` })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    beforeReply = () => blocked
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(60))
    try {
        const page = await read()
        expect(page.items).toEqual([])
        expect(page.unavailableAgentIds).toHaveLength(7)
        expect(calls.length).toBeGreaterThan(0)
        expect(calls.length).toBeLessThanOrEqual(4)
    } finally { release(); beforeReply = undefined; vi.restoreAllMocks() }
    expect((await read()).unavailableAgentIds).toEqual([])
})
