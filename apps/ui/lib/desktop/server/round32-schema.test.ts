import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, test } from 'vitest'
import { initializeDesktopRound28 } from './round28-schema'
import { initializeDesktopRound31 } from './round31-schema'
import { initializeDesktopRound32 } from './round32-schema'
import { remoteMcpSchema, remoteMcpOAuthSchema, remoteMcpStore } from './mcp/store'
import { stdioSchema } from './mcp-stdio/schema'
import { desktopServicesSchema } from './services/schema'
import { sqliteSseCallLedger } from './mcp-sse/ledger'

const folders: string[] = [], clients: ReturnType<typeof createClient>[] = []
afterEach(async () => { clients.splice(0).forEach(db => db.close()); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
async function previous() {
    const folder = await mkdtemp(join(tmpdir(), 'rerun-round32-migrate-')); folders.push(folder)
    const path = join(folder, 'app.db'), db = createClient({ url: `file:${path}` }); clients.push(db)
    await db.executeMultiple("PRAGMA foreign_keys=ON; CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY); CREATE TABLE desktop_composer_drafts(agent_id TEXT,tab_uid TEXT,text TEXT); INSERT INTO desktop_agents VALUES('original'); INSERT INTO desktop_sessions VALUES('original-chat'); INSERT INTO desktop_composer_drafts VALUES('original','tab','Keep this unsent');" + remoteMcpSchema + remoteMcpOAuthSchema + stdioSchema + desktopServicesSchema)
    await db.execute("INSERT INTO desktop_remote_mcp(agent_id,name,url,revision,bearer) VALUES('original','legacy','https://example.com/sse','old-revision','encrypted-placeholder')")
    await initializeDesktopRound28(db); await initializeDesktopRound31(db)
    await db.executeMultiple("CREATE TABLE desktop_pending_inbox_seen_v3(item_id TEXT PRIMARY KEY,agent_id TEXT,session_id TEXT,kind TEXT,seen_at TEXT); INSERT INTO desktop_pending_inbox_seen_v3 VALUES('saved-approval','original','original-chat','approval','2026-11-05T00:00:00Z');")
    return { db, path }
}

test('upgrades version 9 with explicit HTTP metadata and preserves old chats, drafts and credential bytes after reopen', async () => {
    const { db, path } = await previous()
    await initializeDesktopRound32(db)
    const first = (await db.execute('SELECT * FROM desktop_remote_mcp')).rows[0]
    expect(first.id).toMatch(/^[a-f0-9]{32}$/)
    expect(first.transport).toBe('http')
    expect(first.bearer).toBe('encrypted-placeholder')
    const reopened = createClient({ url: `file:${path}` }); clients.push(reopened)
    await initializeDesktopRound32(reopened)
    expect((await reopened.execute('SELECT * FROM desktop_remote_mcp')).rows[0]).toEqual(first)
    expect((await reopened.execute('SELECT id FROM desktop_sessions')).rows).toEqual([{ id: 'original-chat' }])
    expect((await reopened.execute('SELECT text FROM desktop_composer_drafts')).rows[0].text).toBe('Keep this unsent')
    expect((await reopened.execute('SELECT version FROM desktop_schema_migrations ORDER BY version')).rows.map(row => row.version)).toEqual([2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17])
    expect((await reopened.execute('SELECT item_id,kind FROM desktop_pending_inbox_seen_v4')).rows).toEqual([{ item_id: 'saved-approval', kind: 'approval' }])
    const store = remoteMcpStore(reopened, () => Buffer.alloc(32, 1))
    await store.save('original', { name: 'new', url: 'https://example.com/mcp' })
    expect((await store.list('original')).find(row => row.name === 'new')).toMatchObject({ id: expect.any(String), transport: 'http' })
    expect((await reopened.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})

test('a durable SSE claim cannot replay after reopen or have its outcome overwritten', async () => {
    const { db, path } = await previous(); await initializeDesktopRound32(db)
    const call = { agentId: 'original', serverId: 'server', name: 'fixture', expectedRevision: 'revision', requestId: crypto.randomUUID(), sessionId: 'chat', runId: 'run', toolCallId: 'call', tool: 'echo', arguments: {} }
    const ledger = sqliteSseCallLedger(db), signal = new AbortController().signal
    expect(await ledger.claim(call, 'fingerprint', signal)).toBe('new')
    const reopened = createClient({ url: `file:${path}` }); clients.push(reopened)
    const recovered = sqliteSseCallLedger(reopened)
    expect(await recovered.claim(call, 'fingerprint', signal)).toBe('existing')
    await expect(recovered.claim({ ...call, arguments: { changed: true } }, 'changed', signal)).rejects.toThrow()
    const outcome = { requestId: call.requestId, status: 'completed' as const, result: { content: [{ type: 'text', text: '42' }] } }
    await recovered.settle(call, 'fingerprint', outcome)
    await recovered.settle(call, 'fingerprint', outcome)
    await expect(recovered.settle(call, 'fingerprint', { requestId: call.requestId, status: 'uncertain' })).rejects.toThrow()
    expect(JSON.parse(String((await db.execute('SELECT outcome FROM desktop_mcp_sse_calls')).rows[0].outcome))).toEqual(outcome)
})

test('a conflicting new migration identity refuses without changing old connections', async () => {
    const { db } = await previous()
    await db.execute("INSERT INTO desktop_schema_migrations VALUES(10,'foreign-step')")
    await expect(initializeDesktopRound32(db)).rejects.toThrow('identity mismatch')
    expect((await db.execute('SELECT bearer FROM desktop_remote_mcp')).rows[0].bearer).toBe('encrypted-placeholder')
})
