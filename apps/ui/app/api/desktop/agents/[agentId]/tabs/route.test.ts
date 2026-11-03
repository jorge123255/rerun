import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { GET } from '../sessions/route'
import { PUT } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189'
const cookie = 'rerun-desktop-session=' + 'a'.repeat(48)
let root: string, alice: string, bob: string, first: string, second: string, other: string
function request(agentId: string, body?: object) {
    return new Request(origin + '/api/desktop/agents/' + agentId + (body ? '/tabs' : '/sessions'), {
        method: body ? 'PUT' : 'GET', headers: { host: '127.0.0.1:3189', origin, cookie, 'content-type': 'application/json' },
        body: body && JSON.stringify(body),
    })
}
const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
const put = (agentId: string, body: object) => PUT(request(agentId, body), params(agentId))
async function read(agentId: string) {
    const response = await GET(request(agentId), params(agentId))
    expect(response.status).toBe(200)
    return response.json()
}
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-chat-tabs-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'tabs', buildId: 'tabs-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: 'a'.repeat(48) }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'a' })).id
    bob = (await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'b' })).id
    first = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'a-first', title: 'Daily notes' })).id
    second = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'a-second', title: 'Daily notes' })).id
    other = (await createDesktopSession(db, { agentId: bob, engineSessionId: 'b-first', title: 'Daily notes' })).id
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('a coworker keeps its tab order and selected conversation after restart; closing leaves the saved chat in history', async () => {
    expect((await read(alice)).tabs).toBeNull()
    const body = { baseRevision: 0, activeIndex: 2, tabs: [{ uid: 'one', id: first }, { uid: 'draft', id: null }, { uid: 'two', id: second }] }
    const result = await put(alice, body)
    expect(result.status).toBe(200)
    const saved = (await result.json()).tabs
    expect(saved).toMatchObject({ revision: 1, activeIndex: 2, tabs: [
        { uid: 'one', id: first, title: 'Daily notes' }, { uid: 'draft', id: null, title: 'New conversation' }, { uid: 'two', id: second, title: 'Daily notes' },
    ] })
    await closeDesktopDatabase(root)
    expect((await read(alice)).tabs).toEqual(saved)
    expect((await read(bob)).tabs).toBeNull()
    expect((await put(alice, { ...body, baseRevision: 1, activeIndex: 0, tabs: [body.tabs[1]] })).status).toBe(200)
    const resultAfterClose = await read(alice)
    expect(resultAfterClose.sessions).toHaveLength(2)
    expect(resultAfterClose.tabs).toEqual({ revision: 2, activeIndex: 0, tabs: [{ uid: 'draft', id: null, title: 'New conversation' }] })
})

test('only one writer from the same revision wins; an identical lost-response retry recovers it', async () => {
    const firstWrite = { baseRevision: 0, activeIndex: 0, tabs: [{ uid: 'one', id: first }, { uid: 'two', id: second }] }
    const writes = [firstWrite, { ...firstWrite, activeIndex: 1 }]
    const responses = await Promise.all(writes.map(write => put(alice, write)))
    expect(responses.map(r => r.status).sort()).toEqual([200,409])
    const current = (await read(alice)).tabs
    expect((await responses.find(r => r.status === 409)!.json()).tabs).toEqual(current)
    const retry = await put(alice, writes[current.activeIndex])
    expect(retry.status).toBe(200)
    expect((await retry.json()).tabs).toEqual(current)
})

test('an existing workspace upgrades its chats without manufacturing open tabs', async () => {
    const old = await openDesktopDatabase(root)
    await old.execute('DROP TABLE desktop_agent_tabs')
    await closeDesktopDatabase(root)
    const initial = await read(alice)
    expect(initial.tabs).toBeNull()
    expect(initial.sessions.map((s: { id: string }) => s.id)).toContain(first)
    expect((await put(alice, { baseRevision: 0, activeIndex: 0, tabs: [{ uid: 'before-upgrade', id: first }] })).status).toBe(200)
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'DELETE FROM desktop_sessions WHERE id = ?', args: [first] })
    const afterRemoval = await read(alice)
    expect(afterRemoval.tabs).toEqual({ revision: 1, tabs: [{ uid: 'before-upgrade', id: null, title: 'New conversation' }], activeIndex: 0 })
    expect(afterRemoval.sessions).toHaveLength(1)
    expect((await read(bob)).sessions[0].id).toBe(other)
})

test('rejects unowned chats and invalid layouts before writing', async () => {
    const body = { baseRevision: 0, activeIndex: 0, tabs: [{ uid: 'one', id: first }] }
    for (const id of [other, 'absent']) expect((await put(alice, { ...body, tabs: [{ uid: 'one', id }] })).status).toBe(404)
    expect((await put('missing', body)).status).toBe(404)
    for (const update of [{ tabs: [] }, { activeIndex: 1 }, { tabs: [{ uid: 'one', id: first }, { uid: 'one', id: second }] },
        { tabs: [{ uid: 'one', id: null }, { uid: 'two', id: null }] }, { tabs: [{ uid: 'one', id: first }, { uid: 'two', id: first }] }]) {
        expect((await put(alice, { ...body, ...update })).status).toBe(400)
    }
    const unauthorized = request(alice, body)
    unauthorized.headers.delete('cookie')
    expect((await PUT(unauthorized, params(alice))).status).toBe(401)
    expect((await read(alice)).tabs).toBeNull()
})
