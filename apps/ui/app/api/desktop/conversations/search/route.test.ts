import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { GET } from './route'

const originalEnv = { ...process.env }
let root: string, alice: string, bob: string, aliceChat: string, bobChat: string
const request = (text: string) => new Request(`http://127.0.0.1:3189/api/desktop/conversations/search?q=${encodeURIComponent(text)}`, { headers: { host: '127.0.0.1:3189', cookie: `rerun-desktop-session=${'s'.repeat(48)}` } })
const search = async (text: string) => {
    const response = await GET(request(text))
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
