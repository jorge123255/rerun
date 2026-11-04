import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { writeDesktopTabs } from '@/lib/desktop/server/session-tabs'
import { POST as chat } from '../../chat/route'
import { POST as duplicate } from './duplicate/route'
import { GET as roster } from '../route'
import { DELETE } from './route'
import { readDesktopBoardState, writeDesktopBoardState } from '@/lib/desktop/server/spaces'

const origin = 'http://127.0.0.1:3101'
const token = 'd'.repeat(40)
const headers = { origin, host: '127.0.0.1:3101', cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }
const originalEnv = { ...process.env }
let root: string, server: Server, connected: boolean, loseReply: boolean, busy: boolean
const engine = new Map<string, string>()
const deletes: string[] = []

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-delete-'))
    connected = true; loseReply = false; busy = false
    deletes.length = 0; engine.clear()
    engine.set('original', 'Original'); engine.set('copy', 'Original copy')
    server = createServer(async (req, res) => {
        const json = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (!connected) return json(503, {})
        if (req.url === '/agents') return json(200, { agents: [...engine].map(([id, name]) => ({ id, name })) })
        const id = req.url?.slice('/agents/'.length) ?? ''
        if (!engine.has(id)) return json(404, {})
        if (req.method === 'DELETE') {
            if (busy) return json(409, { error: 'active work' })
            deletes.push(id); engine.delete(id)
            if (loseReply) { connected = false; res.destroy(); return }
            return json(200, { deleted: id })
        }
        return json(200, { id, config: { name: id, displayName: engine.get(id), enabled: true }, soul: '' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'delete-launch', buildId: 'delete-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' } }), { mode: 0o600 })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
})

const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
const remove = (id: string, name: unknown, auth = true, extra = {}) => DELETE(new Request(`${origin}/api/desktop/agents/${id}`, {
    method: 'DELETE', headers: auth ? headers : { ...headers, cookie: '' }, body: JSON.stringify({ confirmationName: name, ...extra }),
}), params(id))

it('removes only a deleted coworker membership, invalidates old board writes, and leaves its now-empty Box deletable', async () => {
    const { db, original, copy, originalChat } = await seed()
    const initial = await readDesktopBoardState(db)
    const added = await writeDesktopBoardState(db, { requestId: crypto.randomUUID(), expectedRevision: initial.revision, command: { kind: 'create', name: 'Copy Box' } })
    const box = added.spaces.find(space => space.name === 'Copy Box')!
    const moved = await writeDesktopBoardState(db, { requestId: crypto.randomUUID(), expectedRevision: added.revision, command: { kind: 'move-agent', agentId: copy.id, spaceId: box.id } })
    expect((await remove(copy.id, copy.name)).status).toBe(200)
    const removed = await readDesktopBoardState(db)
    expect(removed.revision).toBe(moved.revision + 1)
    expect(removed.placements).toEqual(initial.placements.filter(item => item.agentId === original.id))
    await expect(writeDesktopBoardState(db, { requestId: crypto.randomUUID(), expectedRevision: moved.revision, command: { kind: 'rename', spaceId: box.id, name: 'Stale' } })).rejects.toMatchObject({ status: 409 })
    const deleted = await writeDesktopBoardState(db, { requestId: crypto.randomUUID(), expectedRevision: removed.revision, command: { kind: 'delete', spaceId: box.id, confirmationName: box.name } })
    expect(deleted.spaces.map(space => space.id)).not.toContain(box.id)
    await closeDesktopDatabase(root)
    const reopened = await openDesktopDatabase(root)
    expect(await readDesktopBoardState(reopened)).toEqual(deleted)
    expect(await listDesktopSessions(reopened, original.id)).toEqual([originalChat])
    expect((await remove(copy.id, copy.name)).status).toBe(200)
    expect(await readDesktopBoardState(reopened)).toEqual(deleted)
})

async function seed(legacy = false) {
    if (legacy) {
        const old = createClient({ url: `file:${join(root, 'app.db')}` })
        await old.execute(`CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, engine_session_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
        old.close()
    }
    const db = await openDesktopDatabase(root)
    const original = await createDesktopAgent(db, { engineAgentId: 'original', name: 'Original' })
    const copy = await createDesktopAgent(db, { engineAgentId: 'copy', name: 'Original copy' })
    const originalChat = await createDesktopSession(db, { agentId: original.id, engineSessionId: 'original-chat', title: 'Original answer' })
    const copyChat = await createDesktopSession(db, { agentId: copy.id, engineSessionId: 'copy-chat', title: 'Copy answer' })
    await writeDesktopTabs(db, copy.id, { baseRevision: 0, activeIndex: 0, tabs: [{ uid: 'copy-tab', id: copyChat.id }] })
    const requestId = crypto.randomUUID()
    await db.execute({ sql: `INSERT INTO desktop_duplicates (request_id,source_id,agent_id,name,handle,board_col,board_row,completed) VALUES (?,?,?,?,?,1,1,1)`,
        args: [requestId, original.id, copy.id, copy.name, 'copy'] })
    return { db, original, copy, originalChat, copyChat, requestId }
}

it('deletes only the confirmed copy, cleans older session tables and retains the original through reopen', async () => {
    const { db, original, copy, originalChat, copyChat } = await seed(true)
    await db.execute({ sql: `INSERT INTO desktop_message_feedback (id,agent_id,session_id,message_id,rating,updated_at) VALUES ('vote',?,?,?,'up','before')`, args: [copy.id, copyChat.id, 'reply'] })
    await db.execute({ sql: `INSERT INTO desktop_regeneration_requests (request_id,source_session_id,message_id,canonical_id,pending) VALUES ('request',?,'reply','canonical',1)`, args: [copyChat.id] })
    const response = await remove(copy.id, copy.name)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deletedAgentId: copy.id })
    expect(await findDesktopAgent(db, copy.id)).toBeNull()
    expect(await listDesktopSessions(db, copy.id)).toEqual([])
    for (const table of ['desktop_message_feedback', 'desktop_regeneration_requests', 'desktop_agent_tabs']) expect((await db.execute(`SELECT * FROM ${table}`)).rows).toEqual([])
    expect(await findDesktopAgent(db, original.id)).toEqual(original)
    expect(await listDesktopSessions(db, original.id)).toEqual([originalChat])
    expect(deletes).toEqual(['copy'])
    await expect(createDesktopSession(db, { agentId: copy.id, engineSessionId: 'late-copy-chat', title: 'Late response' })).rejects.toThrow()
    expect(await listDesktopSessions(db, copy.id)).toEqual([])
    await closeDesktopDatabase(root)
    const reopened = await openDesktopDatabase(root)
    expect(await findDesktopAgent(reopened, copy.id)).toBeNull()
    expect(await listDesktopSessions(reopened, original.id)).toEqual([originalChat])
    expect((await remove(copy.id, copy.name)).status).toBe(200)
    expect(deletes).toEqual(['copy'])
})

it('retains the completed duplicate receipt so a stale placement cannot recreate the deleted copy', async () => {
    const { db, original, copy, requestId } = await seed()
    expect((await remove(copy.id, copy.name)).status).toBe(200)
    const response = await duplicate(new Request(origin + `/api/desktop/agents/${original.id}/duplicate`, {
        method: 'POST', headers, body: JSON.stringify({ requestId, position: { col: 1, row: 1 } }),
    }), params(original.id))
    expect(response.status).toBe(404)
    expect((await db.execute('SELECT * FROM desktop_duplicates')).rows).toHaveLength(1)
    expect(await findDesktopAgent(db, copy.id)).toBeNull()
    expect(deletes).toEqual(['copy'])
})

it('deleting an original preserves its completed copy, placement and independent chat', async () => {
    const { db, original, copy, copyChat } = await seed()
    expect((await remove(original.id, original.name)).status).toBe(200)
    // Current placement is authoritative; a historical duplicate receipt must not
    // move the surviving copy back when its original coworker is deleted.
    expect(await findDesktopAgent(db, copy.id)).toEqual(copy)
    expect(await listDesktopSessions(db, copy.id)).toEqual([copyChat])
    expect((await db.execute('SELECT * FROM desktop_duplicates')).rows).toHaveLength(1)
    expect(deletes).toEqual(['original'])
})

it('recovers a lost engine acknowledgement after restart without discarding chats on an unavailable read', async () => {
    const { db, original, copy, originalChat, copyChat } = await seed()
    loseReply = true
    expect((await remove(copy.id, copy.name)).status).toBe(502)
    expect(await findDesktopAgent(db, copy.id)).not.toBeNull()
    expect(await listDesktopSessions(db, copy.id)).toEqual([copyChat])
    const blocked = await chat(new Request(origin + '/api/desktop/chat', { method: 'POST', headers, body: JSON.stringify({ agentId: copy.id, text: 'Cannot start while deleting' }) }))
    expect(blocked.status).toBe(409)
    await closeDesktopDatabase(root)
    connected = true; loseReply = false
    const response = await roster(new Request(origin + '/api/desktop/agents', { headers }))
    expect(response.status).toBe(200)
    expect((await response.json()).agents.map((row: { id: string }) => row.id)).toEqual([original.id])
    expect(await listDesktopSessions(await openDesktopDatabase(root), original.id)).toEqual([originalChat])
    expect((await remove(copy.id, copy.name)).status).toBe(200)
    expect(deletes).toEqual(['copy'])
})

it('does not defer a busy refusal into a surprise deletion on the next roster read', async () => {
    const { db, copy, copyChat } = await seed()
    busy = true
    const response = await remove(copy.id, copy.name)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('Stop')
    expect((await db.execute('SELECT * FROM desktop_deletions')).rows).toEqual([])
    busy = false
    await roster(new Request(origin + '/api/desktop/agents', { headers }))
    expect(await findDesktopAgent(db, copy.id)).not.toBeNull()
    expect(await listDesktopSessions(db, copy.id)).toEqual([copyChat])
    expect(deletes).toEqual([])
})

it('requires local authentication, owned immutable ID and exact current name', async () => {
    const { db, copy } = await seed()
    expect((await remove(copy.id, copy.name, false)).status).toBe(401)
    expect((await remove('copy', copy.name)).status).toBe(404)
    expect((await remove('missing', copy.name)).status).toBe(404)
    expect((await remove(copy.id, 'Original')).status).toBe(409)
    for (const bad of [null, false, '', 'x'.repeat(61)]) expect((await remove(copy.id, bad)).status).toBe(400)
    expect((await remove(copy.id, copy.name, true, { all: true })).status).toBe(400)
    await db.execute({ sql: 'UPDATE desktop_agents SET name = ? WHERE id = ?', args: ['New copy name', copy.id] })
    expect((await remove(copy.id, copy.name)).status).toBe(409)
    expect(deletes).toEqual([])
})

it('keeps pending copies intact and asks to finish them before deleting their source', async () => {
    const { db, original } = await seed()
    await db.execute({ sql: `INSERT INTO desktop_duplicates (request_id,source_id,agent_id,name,handle,board_col,board_row) VALUES (?,?,?,'Pending','pending',7,7)`,
        args: [crypto.randomUUID(), original.id, crypto.randomUUID()] })
    const response = await remove(original.id, original.name)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('pending coworker copy')
    expect((await db.execute('SELECT * FROM desktop_deletions')).rows).toEqual([])
    expect(deletes).toEqual([])
})
