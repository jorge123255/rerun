import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, readDesktopBootstrap } from '@/lib/desktop/server/store'
import { GET, POST } from './route'

const originalEnv = { ...process.env }
let root: string, ids: string[]
const origin = 'http://127.0.0.1:3189'
const request = (payload?: unknown) => new Request(`${origin}/api/desktop/recent-coworkers`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:3189', origin, cookie: `rerun-desktop-session=${'s'.repeat(48)}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
})
const visit = (agentId: string, baseRevision: number, requestId = crypto.randomUUID()) => ({ agentId, baseRevision, requestId })
const read = async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return response.json()
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-recent-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'recent', buildId: 'recent-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: 's'.repeat(48) }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused-engine' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    ids = []
    for (let index = 0; index < 7; index++) ids.push((await createDesktopAgent(db, { name: `Coworker ${index}`, engineAgentId: `engine-${index}` })).id)
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('starts empty without manufacturing visits or changing the database during reads', async () => {
    const db = await openDesktopDatabase(root)
    expect(await read()).toEqual({ revision: 0, recentAgentIds: [] })
    expect((await readDesktopBootstrap(db)).recentCoworkers).toEqual({ revision: 0, recentAgentIds: [] })
    expect((await db.execute('SELECT * FROM desktop_recent_state')).rows).toEqual([])
})

test('remembers the last five unique coworkers, including disabled history, across database restart', async () => {
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [ids[6]] })
    for (const [index, id] of ids.entries()) expect((await POST(request(visit(id, index)))).status).toBe(200)
    expect(await read()).toEqual({ revision: 7, recentAgentIds: ids.slice(2).reverse() })
    expect((await POST(request(visit(ids[3], 7)))).status).toBe(200)
    const expected = { revision: 8, recentAgentIds: [ids[3], ids[6], ids[5], ids[4], ids[2]] }
    expect(await read()).toEqual(expected)
    await closeDesktopDatabase(root)
    expect(await read()).toEqual(expected)
    expect((await readDesktopBootstrap(await openDesktopDatabase(root))).recentCoworkers).toEqual(expected)
})

test('retries a lost acknowledgment exactly once and refuses stale retries after a newer visit', async () => {
    const first = visit(ids[0], 0)
    expect((await POST(request(first))).status).toBe(200)
    expect(await (await POST(request(first))).json()).toEqual({ revision: 1, recentAgentIds: [ids[0]] })
    const second = visit(ids[1], 1)
    expect((await POST(request(second))).status).toBe(200)
    const stale = await POST(request(first))
    expect(stale.status).toBe(409)
    expect((await stale.json()).recent).toEqual({ revision: 2, recentAgentIds: [ids[1], ids[0]] })
    expect(await read()).toEqual({ revision: 2, recentAgentIds: [ids[1], ids[0]] })
    expect((await POST(request({ ...second, agentId: ids[2] }))).status).toBe(409)
    expect((await POST(request({ ...second, baseRevision: 2 }))).status).toBe(409)
    expect(await read()).toEqual({ revision: 2, recentAgentIds: [ids[1], ids[0]] })
})

test('serializes competing visits so only one matching base revision wins', async () => {
    const responses = await Promise.all([POST(request(visit(ids[0], 0))), POST(request(visit(ids[1], 0)))])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const saved = await read()
    expect(saved.revision).toBe(1)
    expect(saved.recentAgentIds).toHaveLength(1)
    expect(ids.slice(0, 2)).toContain(saved.recentAgentIds[0])
})

test('rejects foreign, engine-only, deleting and deleted owners and cannot restore deleted recents', async () => {
    const db = await openDesktopDatabase(root)
    const first = visit(ids[0], 0)
    await POST(request(first))
    await POST(request(visit(ids[1], 1)))
    await db.execute({ sql: 'INSERT INTO desktop_deletions (agent_id,engine_agent_id,name) VALUES (?, ?, ?)', args: [ids[1], 'engine-1', 'Coworker 1'] })
    expect(await read()).toEqual({ revision: 2, recentAgentIds: [ids[0]] })
    expect((await POST(request(visit(ids[1], 2)))).status).toBe(503)
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [ids[0]] })
    expect((await POST(request(first))).status).toBe(404)
    expect((await db.execute({ sql: 'SELECT * FROM desktop_recent_coworkers WHERE agent_id = ?', args: [ids[0]] })).rows).toEqual([])
    await db.execute('PRAGMA foreign_keys = OFF')
    try { await db.execute({ sql: 'UPDATE desktop_agents SET workspace_id = 2 WHERE id = ?', args: [ids[2]] }) }
    finally { await db.execute('PRAGMA foreign_keys = ON') }
    for (const id of [ids[2], 'engine-3', crypto.randomUUID()]) expect((await POST(request(visit(id, 2)))).status).toBe(404)
    expect(await read()).toEqual({ revision: 2, recentAgentIds: [] })
    await closeDesktopDatabase(root)
    expect(await read()).toEqual({ revision: 2, recentAgentIds: [] })
})

test('a cancelled deletion can retry the same visit without losing its existing history', async () => {
    const db = await openDesktopDatabase(root)
    const pending = visit(ids[0], 0)
    await db.execute({ sql: 'INSERT INTO desktop_deletions (agent_id,engine_agent_id,name) VALUES (?, ?, ?)', args: [ids[0], 'engine-0', 'Coworker 0'] })
    expect((await POST(request(pending))).status).toBe(503)
    await db.execute({ sql: 'DELETE FROM desktop_deletions WHERE agent_id = ?', args: [ids[0]] })
    expect((await POST(request(pending))).status).toBe(200)
    expect(await read()).toEqual({ revision: 1, recentAgentIds: [ids[0]] })
})

test('visiting another coworker does not discard a temporarily deleting recent owner', async () => {
    const db = await openDesktopDatabase(root)
    await POST(request(visit(ids[0], 0)))
    await db.execute({ sql: 'INSERT INTO desktop_deletions (agent_id,engine_agent_id,name) VALUES (?, ?, ?)', args: [ids[0], 'engine-0', 'Coworker 0'] })
    expect((await POST(request(visit(ids[1], 1)))).status).toBe(200)
    expect(await read()).toEqual({ revision: 2, recentAgentIds: [ids[1]] })
    await db.execute({ sql: 'DELETE FROM desktop_deletions WHERE agent_id = ?', args: [ids[0]] })
    expect(await read()).toEqual({ revision: 2, recentAgentIds: [ids[1], ids[0]] })
})

test('requires authenticated same-origin mutations and rejects invalid visit bodies', async () => {
    const good = visit(ids[0], 0)
    const anonymous = request(good); anonymous.headers.delete('cookie')
    expect((await POST(anonymous)).status).toBe(401)
    const noOrigin = request(good); noOrigin.headers.delete('origin')
    expect((await POST(noOrigin)).status).toBe(403)
    const foreignHost = request(); foreignHost.headers.set('host', 'example.invalid')
    expect((await GET(foreignHost)).status).toBe(403)
    const crossSite = request(); crossSite.headers.set('sec-fetch-site', 'cross-site')
    expect((await GET(crossSite)).status).toBe(403)
    for (const body of [null, {}, { ...good, agentId: '' }, { ...good, agentId: 'x'.repeat(201) }, { ...good, baseRevision: -1 }, { ...good, baseRevision: 1.5 }, { ...good, requestId: 'bad' }]) expect((await POST(request(body))).status).toBe(400)
    expect(await read()).toEqual({ revision: 0, recentAgentIds: [] })
})
