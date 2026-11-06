import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, it } from 'vitest'
import { initializeDesktopRound33 } from './round33-schema'
const folders: string[] = [], clients: ReturnType<typeof createClient>[] = []
afterEach(async () => { clients.splice(0).forEach(db => db.close()); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('upgrades the shipped version 17 ledger once and preserves original rows and read receipts after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rerun-33-upgrade-')); folders.push(directory)
    const url = `file:${join(directory, 'app.db')}`, db = createClient({ url }); clients.push(db)
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
      CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL);
      INSERT INTO desktop_schema_migrations VALUES(17,'catalog-account-lifecycle');
      CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('original');
      CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY); INSERT INTO desktop_sessions VALUES('original-chat');
      CREATE TABLE desktop_composer_drafts(agent_id TEXT,tab_uid TEXT,text TEXT); INSERT INTO desktop_composer_drafts VALUES('original','tab','Keep this unsent');
      CREATE TABLE desktop_pending_inbox_seen_v4(item_id TEXT PRIMARY KEY,agent_id TEXT,session_id TEXT,kind TEXT,seen_at TEXT);
      INSERT INTO desktop_pending_inbox_seen_v4 VALUES('saved-approval','original','original-chat','approval','before');`)
    await initializeDesktopRound33(db)
    const before = (await db.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows
    expect(before.map(row => row.version)).toEqual([17,18,19,20,21,22,23,24])
    const next = createClient({ url }); clients.push(next)
    await initializeDesktopRound33(next)
    expect((await next.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows).toEqual(before)
    expect((await next.execute('SELECT * FROM desktop_composer_drafts')).rows[0].text).toBe('Keep this unsent')
    expect((await next.execute('SELECT * FROM desktop_sessions')).rows).toEqual([{ id: 'original-chat' }])
    expect((await next.execute('SELECT item_id,kind FROM desktop_pending_inbox_seen_v5')).rows).toEqual([{ item_id: 'saved-approval', kind: 'approval' }])
    expect((await next.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
