import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { GET } from './route'

const originalEnv = { ...process.env }
let root: string, alice: string, bob: string, aliceChat: string, bobChat: string
const request = (text: string, agentId?: string) => new Request(`http://127.0.0.1:3189/api/desktop/conversations/search?q=${encodeURIComponent(text)}${agentId === undefined ? '' : `&agentId=${encodeURIComponent(agentId)}`}`, { headers: { host: '127.0.0.1:3189', cookie: `rerun-desktop-session=${'s'.repeat(48)}` } })
const search = async (text: string, agentId?: string) => {
    const response = await GET(request(text, agentId))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return response.json()
}
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-chat-search-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'search', buildId: 'search-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3189', sessionToken: 's'.repeat(48) }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused-engine' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' })).id
    bob = (await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })).id
    aliceChat = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'engine-a', title: 'Shared plan' })).id
    bobChat = (await createDesktopSession(db, { agentId: bob, engineSessionId: 'engine-b', title: 'Shared plan' })).id
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('searches titles across coworkers using stable local conversation IDs without needing the engine', async () => {
    const body = await search('  SHARED  ')
    expect(body).toEqual({ hasMore: false, hits: [
        { id: bobChat, agentId: bob, agentName: 'Bob', title: 'Shared plan' },
        { id: aliceChat, agentId: alice, agentName: 'Alice', title: 'Shared plan' },
    ] })
    expect(JSON.stringify(body)).not.toContain('engine-')
    expect((await search('Alice')).hits).toEqual([])
})
test('returns no matches and bounds empty, short and oversized queries', async () => {
    for (const text of ['', ' ', 's', 'no such chat']) expect(await search(text)).toEqual({ hits: [], hasMore: false })
    expect((await GET(request('x'.repeat(201)))).status).toBe(400)
})
test('treats SQL wildcard and quote characters as literal title text', async () => {
    const db = await openDesktopDatabase(root)
    const literal = await createDesktopSession(db, { agentId: alice, engineSessionId: 'engine-literal', title: "100%_done 'quote'" })
    for (const query of ['%_', "'quote'"]) expect((await search(query)).hits.map((hit: { id: string }) => hit.id)).toEqual([literal.id])
    expect((await search("' OR 1=1 --")).hits).toEqual([])
})
test('authenticates the local session and rejects cross-site/foreign host reads', async () => {
    const anonymous = request('Shared'); anonymous.headers.delete('cookie')
    expect((await GET(anonymous)).status).toBe(401)
    const foreign = request('Shared'); foreign.headers.set('host', 'example.invalid')
    expect((await GET(foreign)).status).toBe(403)
    const crossSite = request('Shared'); crossSite.headers.set('sec-fetch-site', 'cross-site')
    expect((await GET(crossSite)).status).toBe(403)
})
test('searches the whole saved history before limiting results and signals additional matches', async () => {
    const db = await openDesktopDatabase(root)
    for (let index = 0; index < 52; index++) await createDesktopSession(db, { agentId: alice, engineSessionId: `engine-new-${index}`, title: `Recent match ${index}` })
    expect((await search('Recent match')).hits).toHaveLength(50)
    expect((await search('Recent match')).hasMore).toBe(true)
    expect((await search('Shared plan')).hits.map((hit: { id: string }) => hit.id)).toEqual([bobChat, aliceChat])
})
test('keeps duplicate-title identities and coworker labels after closing and reopening the store', async () => {
    const before = await search('Shared')
    await closeDesktopDatabase(root)
    expect(await search('Shared')).toEqual(before)
})

test('scopes to the coworker before the result limit so other coworkers cannot hide an older matching chat', async () => {
    const db = await openDesktopDatabase(root)
    for (let index = 0; index < 52; index++) await createDesktopSession(db, { agentId: bob, engineSessionId: `engine-bob-shared-${index}`, title: `Shared plan ${index}` })
    const all = await search('Shared')
    expect(all.hasMore).toBe(true)
    expect(all.hits).toHaveLength(50)
    expect(all.hits.every((hit: { agentId: string }) => hit.agentId === bob)).toBe(true)
    expect(await search('Shared', alice)).toEqual({ hasMore: false, hits: [
        { id: aliceChat, agentId: alice, agentName: 'Alice', title: 'Shared plan' },
    ] })
    const scoped = await search('Shared', bob)
    expect(scoped.hasMore).toBe(true)
    expect(scoped.hits).toEqual(all.hits)
})

test('keeps a disabled coworker scoped and preserves exact conversation identities after restart', async () => {
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [alice] })
    const before = await search('  SHARED  ', alice)
    expect(before.hits.map((hit: { id: string }) => hit.id)).toEqual([aliceChat])
    await closeDesktopDatabase(root)
    expect(await search('Shared', alice)).toEqual(before)
    expect(await search('', alice)).toEqual({ hits: [], hasMore: false })
})

test('rejects unknown, engine-only and deleted coworker scopes without falling back to global matches', async () => {
    for (const id of [crypto.randomUUID(), 'engine-alice', "' OR 1=1 --"]) {
        for (const text of ['Shared', '']) expect((await GET(request(text, id))).status).toBe(404)
    }
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [alice] })
    expect((await GET(request('Shared', alice))).status).toBe(404)
    expect((await search('Shared')).hits.map((hit: { id: string }) => hit.id)).toEqual([bobChat])
})

test('excludes persisted foreign-workspace owners from global and scoped searches', async () => {
    const db = await openDesktopDatabase(root)
    // Simulate an imported invalid owner row; the single-workspace schema normally prevents it.
    await db.execute('PRAGMA foreign_keys = OFF')
    try {
        await db.execute({ sql: 'UPDATE desktop_agents SET workspace_id = 2 WHERE id = ?', args: [bob] })
    } finally {
        await db.execute('PRAGMA foreign_keys = ON')
    }
    expect((await GET(request('Shared', bob))).status).toBe(404)
    expect((await GET(request('', bob))).status).toBe(404)
    expect((await search('Shared')).hits.map((hit: { id: string }) => hit.id)).toEqual([aliceChat])
})

test('rejects empty, oversized or ambiguous coworker scopes and still authenticates scoped reads', async () => {
    for (const scope of ['', ' ', 'x'.repeat(201)]) expect((await GET(request('Shared', scope))).status).toBe(400)
    const first = request('Shared', alice)
    const duplicate = new Request(`${first.url}&agentId=${encodeURIComponent(bob)}`, { headers: first.headers })
    expect((await GET(duplicate)).status).toBe(400)
    const anonymous = request('Shared', alice); anonymous.headers.delete('cookie')
    expect((await GET(anonymous)).status).toBe(401)
})
