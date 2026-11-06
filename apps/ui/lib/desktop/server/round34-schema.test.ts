import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, it } from 'vitest'
import { initializeDesktopRound34 } from './round34-schema'

const folders: string[] = [], clients: ReturnType<typeof createClient>[] = []
afterEach(async () => { clients.splice(0).forEach(db => db.close()); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('upgrades version24 without changing prior drafts, chats or exact MCP binding revisions on reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rerun-34-upgrade-')); folders.push(directory)
    const url = `file:${join(directory, 'app.db')}`, db = createClient({ url }); clients.push(db)
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
      CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL);
      INSERT INTO desktop_schema_migrations VALUES(24,'mcp-install-pending-inbox');
      CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('original');
      CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY); INSERT INTO desktop_sessions VALUES('original-chat');
      CREATE TABLE desktop_composer_drafts(agent_id TEXT,tab_uid TEXT,text TEXT); INSERT INTO desktop_composer_drafts VALUES('original','tab','Keep this unsent');`)
    await initializeDesktopRound34(db)
    const revision = '52a62dde-132e-41b5-a1cf-f192228cf932'
    await db.execute({ sql: `INSERT INTO desktop_mcp_secret_reference_heads VALUES(?,?,?,?,?,?,?,?,?)`, args: ['original', 'example', revision, 1, 'user', 'fingerprint', 'reference', '{}', 'before'] })
    const before = (await db.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows
    expect(before.map(row => row.version)).toEqual([24,25,26])
    const next = createClient({ url }); clients.push(next)
    await initializeDesktopRound34(next)
    expect((await next.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows).toEqual(before)
    expect((await next.execute('SELECT config_revision,binding_revision FROM desktop_mcp_secret_reference_heads')).rows).toEqual([{ config_revision: revision, binding_revision: 1 }])
    expect((await next.execute('SELECT * FROM desktop_composer_drafts')).rows[0].text).toBe('Keep this unsent')
    expect((await next.execute('SELECT * FROM desktop_sessions')).rows).toEqual([{ id: 'original-chat' }])
    expect((await next.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
