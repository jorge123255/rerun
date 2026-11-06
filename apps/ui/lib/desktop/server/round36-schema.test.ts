import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it } from 'vitest'
import { initializeDesktopRound36 } from './round36-schema'

const roots: string[] = [], clients: Client[] = []
afterEach(async () => { clients.splice(0).forEach(db => db.close()); await Promise.all(roots.splice(0).map(path => rm(path,{ recursive: true,force: true }))) })
async function fixture() {
    const root = await mkdtemp(join(tmpdir(),'rerun-rd36-upgrade-')); roots.push(root)
    const url = `file:${join(root,'app.db')}`, db = createClient({ url }); clients.push(db)
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
        CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL);
        INSERT INTO desktop_schema_migrations VALUES(30,'foreman-company-intake');
        CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('original');
        CREATE TABLE original_drafts(text TEXT); INSERT INTO original_drafts VALUES('Keep this unsent');`)
    return { db,url }
}
it('appends RD36 receipts once and preserves prior chats and migration identities after reopening', async () => {
    const { db,url } = await fixture()
    await initializeDesktopRound36(db)
    await db.execute("INSERT INTO desktop_coworker_share_attempts VALUES(2,'original','opaque-attempt','export','hash','{}','before')")
    const next = createClient({ url }); clients.push(next)
    await initializeDesktopRound36(next)
    expect((await next.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows).toEqual([
        { version: 30,id: 'foreman-company-intake' },{ version: 31,id: 'shared-file-mutation-receipts' },
        { version: 32,id: 'coworker-share-snapshots' },{ version: 33,id: 'external-mcp-ui-attempts' },
    ])
    expect((await next.execute('SELECT text FROM original_drafts')).rows).toEqual([{ text: 'Keep this unsent' }])
    expect((await next.execute('SELECT workspace_id,request_id FROM desktop_coworker_share_attempts')).rows).toEqual([{ workspace_id: 2,request_id: 'opaque-attempt' }])
    expect((await next.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
it('refuses a conflicting shipped identity before publishing any RD36 schema', async () => {
    const { db } = await fixture()
    await db.execute("INSERT INTO desktop_schema_migrations VALUES(31,'other-owner')")
    await expect(initializeDesktopRound36(db)).rejects.toThrow('Desktop migration identity mismatch')
    expect((await db.execute("SELECT name FROM sqlite_master WHERE name='desktop_coworker_shares'")).rows).toEqual([])
    expect((await db.execute('SELECT text FROM original_drafts')).rows[0].text).toBe('Keep this unsent')
})
