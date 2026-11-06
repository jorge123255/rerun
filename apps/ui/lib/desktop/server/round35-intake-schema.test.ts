import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it } from 'vitest'
import { initializeDesktopRound35 } from './round35-schema'

const roots: string[] = [], clients: Client[] = []
afterEach(async () => { clients.forEach(db => db.close()); clients.length = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function database() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-intake-upgrade-')); roots.push(root)
    const url = `file:${join(root, 'app.db')}`, db = createClient({ url }); clients.push(db)
    await db.executeMultiple(`CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL);
        INSERT INTO desktop_schema_migrations VALUES(27,'public-company-discovery'),(28,'foreman-voice-attempts'),(29,'foreman-docs-receipts');
        CREATE TABLE desktop_foreman_chats(chat_id TEXT PRIMARY KEY,ui TEXT); INSERT INTO desktop_foreman_chats VALUES('original','Keep the original draft');`)
    return { db, url }
}

it('appends intake version30 once and preserves the original chat and prior migration identities on reopen', async () => {
    const { db, url } = await database()
    const before = (await db.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows
    await initializeDesktopRound35(db)
    const next = createClient({ url }); clients.push(next)
    await initializeDesktopRound35(next)
    expect((await next.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows).toEqual([...before, { version: 30, id: 'foreman-company-intake' }])
    expect((await next.execute('SELECT * FROM desktop_foreman_chats')).rows).toEqual([{ chat_id: 'original', ui: 'Keep the original draft' }])
    expect((await next.execute('SELECT count(*) AS n FROM desktop_foreman_intake_completions')).rows[0].n).toBe(0)
    expect((await next.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='desktop_foreman_intake_completion_reserved_chat'")).rows).toHaveLength(1)
})

it('refuses a conflicting version30 identity without creating intake tables or replacing the old draft', async () => {
    const { db } = await database()
    await db.execute("INSERT INTO desktop_schema_migrations VALUES(30,'another-owner')")
    await expect(initializeDesktopRound35(db)).rejects.toThrow('Desktop migration identity mismatch')
    expect((await db.execute("SELECT name FROM sqlite_master WHERE name='desktop_foreman_intake_sessions'")).rows).toEqual([])
    expect((await db.execute('SELECT ui FROM desktop_foreman_chats')).rows[0].ui).toBe('Keep the original draft')
})
