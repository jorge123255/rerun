import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Session } from '@rerun/contracts'
import { desktopControlCenterChatsSchema } from '@/lib/desktop/control-center-chats'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import { writeDesktopTabs } from '@/lib/desktop/server/session-tabs'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET } from './route'

const originalEnv = { ...process.env }
const createdAt = '2026-11-01T12:00:00.000Z'
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent
let openChat: DesktopSession, older: DesktopSession, newer: DesktopSession, other: DesktopSession
let mode: 'ok' | 'failed' | 'malformed' = 'ok'
let beforeEngineReply: (() => Promise<void>) | undefined
const remote: Session[] = [], calls: string[] = []

function request(agentId: string, cookie = runtime.app.sessionToken) {
    return new Request(`${runtime.app.origin}/api/desktop/agents/${agentId}/control-center-chats`, {
        headers: { host: new URL(runtime.app.origin).host, cookie: `rerun-desktop-session=${cookie}` },
    })
}
const get = (agentId = alice.id) => GET(request(agentId), { params: Promise.resolve({ agentId }) })
async function read(agentId = alice.id) {
    const response = await get(agentId)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return desktopControlCenterChatsSchema.parse(await response.json())
}
async function seed(owner: DesktopAgent, engineId: string, updatedAt: string, title = 'Shared title') {
    const local = await createDesktopSession(await openDesktopDatabase(root), { agentId: owner.id, engineSessionId: engineId, title })
    await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_sessions SET created_at = ?, updated_at = ? WHERE id = ?', args: [createdAt, createdAt, local.id] })
    remote.push({ id: engineId, agentId: owner.engineAgentId, title: 'Engine title is not UI authority', status: 'open', source: 'dashboard',
        originAgentId: null, originSessionId: null, createdAt, updatedAt })
    return { ...local, createdAt, updatedAt: createdAt }
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-control-center-chats-'))
    remote.length = 0; calls.length = 0; mode = 'ok'; beforeEngineReply = undefined
    server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`)
        const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (req.method !== 'GET' || !/^\/agents\/[^/]+\/sessions$/.test(req.url ?? '')) return reply(404, { error: 'Unexpected engine operation' })
        void (async () => {
            await beforeEngineReply?.()
            if (mode === 'failed') return reply(503, { error: 'Unavailable' })
            // Deliberately return other owners too: the adapter must enforce the target's engine
            // identity itself instead of relying on this HTTP fixture to do its filtering.
            return reply(200, mode === 'malformed' ? { sessions: null } : { sessions: remote })
        })().catch(() => reply(500, { error: 'Fixture callback failed' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: 'control-center-chats', buildId: 'control-center-chats-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3196', sessionToken: 'c'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' })
    bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    openChat = await seed(alice, 'open-chat', '2026-11-04T12:00:00.000Z')
    older = await seed(alice, 'older-chat', '2026-11-02T12:00:00.000Z')
    newer = await seed(alice, 'newer-chat', '2026-11-03T12:00:00.000Z')
    other = await seed(bob, 'other-chat', '2026-11-05T12:00:00.000Z')
    await writeDesktopTabs(db, alice.id, { baseRevision: 0, activeIndex: 1, tabs: [{ uid: 'saved-open', id: openChat.id }, { uid: 'blank-open', id: null }] })
    await writeDesktopTabs(db, bob.id, { baseRevision: 0, activeIndex: 0, tabs: [{ uid: 'saved-open', id: other.id }] })
    calls.length = 0
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('lists genuine open tabs in strip order and recent chats by engine activity without mutating the store or reading drafts', async () => {
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'INSERT INTO desktop_composer_drafts (agent_id, tab_uid, revision, text, attachment_path, updated_at) VALUES (?,?,?,?,?,?)',
        args: [alice.id, 'blank-open', 1, 'PRIVATE UNSENT CONTENT', 'notes.md', createdAt] })
    const before = (await db.execute('SELECT total_changes() AS changes')).rows[0].changes
    const result = await read()
    expect(result).toEqual({ agentId: alice.id, openChats: [
        { agentId: alice.id, tabUid: `general:${alice.id}`, sessionId: null, title: 'General', kind: 'general', firstMessage: null },
        { agentId: alice.id, tabUid: 'saved-open', sessionId: openChat.id, title: 'Shared title', kind: 'thread', firstMessage: null },
        { agentId: alice.id, tabUid: 'blank-open', sessionId: null, title: 'New conversation', kind: 'thread', firstMessage: null },
    ], recentChats: [newer, older].map(session => ({ id: session.id, agentId: alice.id, agentName: 'Alice', title: 'Shared title', kind: 'thread', firstMessage: null })), recentStatus: 'ok', hasMore: false })
    expect(JSON.stringify(result)).not.toContain('PRIVATE UNSENT CONTENT')
    expect(JSON.stringify(result)).not.toContain('engine-')
    expect((await db.execute('SELECT total_changes() AS changes')).rows[0].changes).toBe(before)
    expect(calls).toEqual(['GET /agents/engine-alice/sessions'])
})

test('does not manufacture a blank when no layout exists, and preserves disabled owners through store restart', async () => {
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'DELETE FROM desktop_agent_tabs WHERE agent_id = ?', args: [alice.id] })
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [alice.id] })
    const before = await read()
    expect(before.openChats).toEqual([{ agentId: alice.id, tabUid: `general:${alice.id}`, sessionId: null, title: 'General', kind: 'general', firstMessage: null }])
    expect(before.openChats.some(chat => chat.title === 'New conversation')).toBe(false)
    expect(before.recentChats.map(chat => chat.id)).toEqual([openChat.id, newer.id, older.id])
    await closeDesktopDatabase(root)
    expect(await read()).toEqual(before)
    expect((await (await openDesktopDatabase(root)).execute({ sql: 'SELECT * FROM desktop_agent_tabs WHERE agent_id = ?', args: [alice.id] })).rows).toEqual([])
})

test('excludes all open saved chats before taking eight recent rows and preserves same-title identities', async () => {
    const chats = [openChat, older, newer]
    for (let index = 0; index < 14; index++) chats.push(await seed(alice, `extra-${index}`, createdAt))
    chats.forEach((chat, index) => { remote.find(row => row.id === chat.engineSessionId)!.updatedAt = new Date(Date.UTC(2026, 10, 10, 0, 0, 17 - index)).toISOString() })
    await writeDesktopTabs(await openDesktopDatabase(root), alice.id, { baseRevision: 1, activeIndex: 0,
        tabs: chats.slice(0, 8).map((chat, index) => ({ uid: `open-${index}`, id: chat.id })) })
    const result = await read()
    expect(result.openChats.map(chat => chat.sessionId)).toEqual([null, ...chats.slice(0, 8).map(chat => chat.id)])
    expect(result.recentChats.map(chat => chat.id)).toEqual(chats.slice(8, 16).map(chat => chat.id))
    expect(result.hasMore).toBe(true)
    await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agent_tabs SET layout = ? WHERE agent_id = ?',
        args: [JSON.stringify({ activeIndex: 0, tabs: chats.slice(0, 9).map((chat, index) => ({ uid: `legacy-${index}`, id: chat.id })) }), alice.id] })
    const legacy = await read()
    expect(legacy.openChats).toHaveLength(9)
    expect(legacy.recentChats.map(chat => chat.id)).toEqual(chats.slice(9).map(chat => chat.id))
    expect(legacy.hasMore).toBe(false)
})

test('resolves a first send by its stable blank-tab UID without recovering or rewriting anything', async () => {
    const first = await seed(alice, 'first-send', '2026-11-06T12:00:00.000Z', 'First message')
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: `INSERT INTO desktop_tab_starts (agent_id,uid,input_hash,engine_session_id,run_id,title,model_choice,launch_nonce)
        VALUES (?,?,?,?,?,?,?,?)`, args: [alice.id, 'blank-open', 'fixture-hash', first.engineSessionId, 'fixture-run', first.title, 'null', 'old-launch'] })
    const before = (await db.execute('SELECT total_changes() AS changes')).rows[0].changes
    const result = await read()
    expect(result.openChats[2]).toEqual({ agentId: alice.id, tabUid: 'blank-open', sessionId: first.id, title: first.title, kind: 'thread', firstMessage: null })
    expect(result.recentChats.some(chat => chat.id === first.id)).toBe(false)
    expect((await db.execute('SELECT total_changes() AS changes')).rows[0].changes).toBe(before)
    expect(calls).toEqual(['GET /agents/engine-alice/sessions'])
})

test('filters invalid legacy saved targets instead of exposing the panel helper synthetic blank, and deduplicates valid tabs', async () => {
    const db = await openDesktopDatabase(root)
    const writeRaw = (tabs: { uid: string; id: string | null }[]) => db.execute({ sql: 'UPDATE desktop_agent_tabs SET layout = ? WHERE agent_id = ?', args: [JSON.stringify({ activeIndex: 0, tabs }), alice.id] })
    await writeRaw([{ uid: 'gone', id: 'missing-chat' }, { uid: 'foreign', id: other.id }])
    expect((await read()).openChats).toEqual([{ agentId: alice.id, tabUid: `general:${alice.id}`, sessionId: null, title: 'General', kind: 'general', firstMessage: null }])
    await writeRaw([{ uid: 'saved', id: openChat.id }, { uid: 'duplicate', id: openChat.id }, { uid: 'blank', id: null }, { uid: 'blank-again', id: null }])
    expect((await read()).openChats.map(chat => chat.tabUid)).toEqual([`general:${alice.id}`, 'saved', 'blank'])
    await writeRaw([{ uid: 'ambiguous', id: openChat.id }, { uid: 'ambiguous', id: null }])
    expect((await get()).status).toBe(503)
    await db.execute({ sql: 'UPDATE desktop_agent_tabs SET layout = ? WHERE agent_id = ?', args: ['{"tabs":[],"activeIndex":0}', alice.id] })
    expect((await get()).status).toBe(503)
})

test('failed, malformed or incomplete engine listings leave open tabs usable but never invent recent order', async () => {
    const open = (await read()).openChats
    for (const failure of ['failed', 'malformed'] as const) {
        mode = failure
        expect(await read()).toMatchObject({ openChats: open, recentChats: [], recentStatus: 'unavailable', hasMore: false })
    }
    mode = 'ok'
    const removed = remote.splice(remote.findIndex(row => row.id === older.engineSessionId), 1)[0]
    expect(await read()).toMatchObject({ openChats: open, recentChats: [], recentStatus: 'unavailable', hasMore: false })
    remote.push({ ...removed, updatedAt: 'unknown' })
    expect((await read()).recentStatus).toBe('unavailable')
    remote[remote.length - 1] = removed
    expect((await read()).recentStatus).toBe('ok')
})

test('ignores engine-only and foreign sessions, deduplicates repeated engine rows, and uses stable ties', async () => {
    remote.find(row => row.id === newer.engineSessionId)!.updatedAt = remote.find(row => row.id === older.engineSessionId)!.updatedAt
    remote.push({ ...remote.find(row => row.id === newer.engineSessionId)! })
    remote.push({ ...remote[0], id: 'unmirrored-engine-only', updatedAt: '2099-01-01T00:00:00.000Z' })
    const result = await read()
    expect(result.recentChats.map(chat => chat.id)).toEqual([newer.id, older.id].sort((a, b) => a.localeCompare(b)))
    expect(result.recentChats.every(chat => chat.agentId === alice.id)).toBe(true)
    expect((await read(bob.id)).recentChats).toEqual([])
    remote.find(row => row.id === older.engineSessionId)!.agentId = bob.engineAgentId
    expect((await read()).recentStatus).toBe('unavailable')
})

test('requires local authentication and owned, nondeleting coworkers before reading the engine', async () => {
    const anonymous = request(alice.id, 'wrong')
    expect((await GET(anonymous, { params: Promise.resolve({ agentId: alice.id }) })).status).toBe(401)
    const foreignHost = request(alice.id); foreignHost.headers.set('host', 'example.invalid')
    expect((await GET(foreignHost, { params: Promise.resolve({ agentId: alice.id }) })).status).toBe(403)
    const crossSite = request(alice.id); crossSite.headers.set('sec-fetch-site', 'cross-site')
    expect((await GET(crossSite, { params: Promise.resolve({ agentId: alice.id }) })).status).toBe(403)
    expect((await get('missing')).status).toBe(404)
    expect((await get(alice.engineAgentId)).status).toBe(404)
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'INSERT INTO desktop_deletions (agent_id,engine_agent_id,name) VALUES (?,?,?)', args: [alice.id, alice.engineAgentId, alice.name] })
    expect((await get()).status).toBe(503)
    await db.execute({ sql: 'UPDATE desktop_deletions SET completed = 1 WHERE agent_id = ?', args: [alice.id] })
    expect((await get()).status).toBe(404)
    expect(calls).toEqual([])
})

test('rejects a persisted foreign-workspace owner rather than using its engine connection', async () => {
    const db = await openDesktopDatabase(root)
    await db.execute('PRAGMA foreign_keys = OFF')
    try { await db.execute({ sql: 'UPDATE desktop_agents SET workspace_id = 2 WHERE id = ?', args: [bob.id] }) }
    finally { await db.execute('PRAGMA foreign_keys = ON') }
    expect((await get(bob.id)).status).toBe(404)
    expect(calls).toEqual([])
})

test('uses the current tab snapshot after an engine read overlaps tab changes', async () => {
    beforeEngineReply = async () => {
        await writeDesktopTabs(await openDesktopDatabase(root), alice.id, { baseRevision: 1, activeIndex: 0,
            tabs: [{ uid: 'different-open', id: newer.id }] })
    }
    const result = await read()
    expect(result.openChats).toEqual([
        { agentId: alice.id, tabUid: `general:${alice.id}`, sessionId: null, title: 'General', kind: 'general', firstMessage: null },
        { agentId: alice.id, tabUid: 'different-open', sessionId: newer.id, title: newer.title, kind: 'thread', firstMessage: null },
    ])
    expect(result.recentChats.map(chat => chat.id)).toEqual([openChat.id, older.id])
})

test('revalidates deletion after the engine read and never returns the removed coworker snapshot', async () => {
    beforeEngineReply = async () => {
        await (await openDesktopDatabase(root)).execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [alice.id] })
    }
    expect((await get()).status).toBe(404)
    expect(calls).toEqual(['GET /agents/engine-alice/sessions'])
})

test('revalidates pending removal and engine identity after the network await', async () => {
    beforeEngineReply = async () => {
        await (await openDesktopDatabase(root)).execute({ sql: 'INSERT INTO desktop_deletions (agent_id,engine_agent_id,name) VALUES (?,?,?)', args: [alice.id, alice.engineAgentId, alice.name] })
    }
    expect((await get()).status).toBe(503)
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'DELETE FROM desktop_deletions WHERE agent_id = ?', args: [alice.id] })
    beforeEngineReply = async () => {
        await db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id = ? WHERE id = ?', args: ['replacement-engine', alice.id] })
    }
    expect((await get()).status).toBe(409)
})
