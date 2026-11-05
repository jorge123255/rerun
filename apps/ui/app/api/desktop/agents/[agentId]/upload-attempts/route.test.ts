import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { writeDesktopTabs } from '@/lib/desktop/server/session-tabs'
import { GET, POST, DELETE } from './route'

const env = { ...process.env }, origin = 'http://127.0.0.1:3189', token = 'u'.repeat(48)
let root: string, alice: string, bob: string
const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
function request(agentId: string, method = 'GET', body?: object, headers?: Record<string, string>) {
    return new Request(`${origin}/api/desktop/agents/${agentId}/upload-attempts?tabUid=live`, { method,
        headers: { host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + token, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) })
}
const reservation = () => ({ tabUid: 'live', id: crypto.randomUUID(), name: 'notes.md', size: 12 })
const post = (body: object, owner = alice) => POST(request(owner, 'POST', body), params(owner))
const get = (owner = alice) => GET(request(owner), params(owner))
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-upload-attempts-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'uploads', buildId: 'upload-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'alice-engine', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'bob-engine', name: 'Bob' })).id
    for (const agentId of [alice, bob]) {
        const session = await createDesktopSession(db, { agentId, engineSessionId: agentId + '-engine', title: 'Chat' })
        await writeDesktopTabs(db, agentId, { baseRevision: 0, tabs: [{ uid: 'live', id: session.id }], activeIndex: 0 })
    }
})
afterEach(async () => { await closeDesktopDatabase(root); process.env = { ...env }; await rm(root, { recursive: true, force: true }) })

test('unfinished metadata survives restart; replay is never a fresh import admission', async () => {
    const input = reservation()
    expect(await (await post(input)).json()).toMatchObject({ created: true, attempt: { id: input.id, name: input.name, size: 12 } })
    await closeDesktopDatabase(root)
    expect(await (await get()).json()).toEqual({ attempts: [{ id: input.id, name: input.name, size: 12 }] })
    expect(await (await post(input)).json()).toMatchObject({ created: false })
    expect(await (await get(bob)).json()).toEqual({ attempts: [] })
    expect((await post({ ...input, name: 'different.txt' })).status).toBe(409)
    expect((await post(input, bob)).status).toBe(409)
    await DELETE(request(bob, 'DELETE', { tabUid: 'live', id: input.id }), params(bob))
    expect((await (await get()).json()).attempts).toHaveLength(1)
    await DELETE(request(alice, 'DELETE', { tabUid: 'live', id: input.id }), params(alice))
    expect(await (await get()).json()).toEqual({ attempts: [] })
})

test('authenticated bounded records require the exact current coworker tab', async () => {
    expect((await POST(request(alice, 'POST', reservation(), { cookie: '' }), params(alice))).status).toBe(401)
    expect((await POST(request(alice, 'POST', reservation(), { origin: 'https://example.com' }), params(alice))).status).toBe(403)
    expect((await post({ ...reservation(), tabUid: 'closed' })).status).toBe(404)
    for (const patch of [{ name: '../notes.md' }, { size: 32769 }, { content: 'Do not store bytes' }, { name: 'x'.repeat(256) + '.txt' }])
        expect((await post({ ...reservation(), ...patch })).status).toBe(400)
    expect((await post({ ...reservation(), content: 'x'.repeat(3000) })).status).toBe(413)
    for (let index = 0; index < 10; index++) expect((await post(reservation())).status).toBe(200)
    expect((await post(reservation())).status).toBe(409)
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'UPDATE desktop_agent_tabs SET layout=? WHERE agent_id=?', args: [JSON.stringify({ tabs: [{ uid: 'new', id: null }], activeIndex: 0 }), alice] })
    expect((await get()).status).toBe(404)
    expect((await post(reservation())).status).toBe(404)
})
