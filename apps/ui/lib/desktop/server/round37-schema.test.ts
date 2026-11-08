import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test } from 'vitest'
import { initializeDesktopRound37 } from './round37-schema'
import { createSqliteDesktopCompanyProfileStore } from './company-profile/store'
import { profileAttempt } from '@/lib/desktop/company-profile/test-fixtures'

const roots: string[] = [], clients: Client[] = []
afterEach(async () => {
    clients.splice(0).forEach(db => db.close())
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-profile-migration-')); roots.push(root)
    const url = `file:${join(root, 'app.db')}`, db = createClient({ url }); clients.push(db)
    await db.executeMultiple(`CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL);
        INSERT INTO desktop_schema_migrations VALUES(33,'external-mcp-ui-attempts');
        CREATE TABLE original_drafts(text TEXT); INSERT INTO original_drafts VALUES('Keep this draft');`)
    return { db, url }
}
test('migration34 preserves prior data and the same saved profile attempt after reopening', async () => {
    const { db, url } = await fixture()
    await initializeDesktopRound37(db)
    const attempt = profileAttempt('enrich')
    await createSqliteDesktopCompanyProfileStore(db, { schemaReady: true }).insert(attempt)
    const reopened = createClient({ url }); clients.push(reopened)
    await initializeDesktopRound37(reopened)
    expect((await reopened.execute('SELECT version,id FROM desktop_schema_migrations ORDER BY version')).rows).toEqual([
        { version: 33, id: 'external-mcp-ui-attempts' }, { version: 34, id: 'company-profile-derived-attempts' }, { version: 35, id: 'fx-board-camera' },
    ])
    expect((await reopened.execute('SELECT text FROM original_drafts')).rows).toEqual([{ text: 'Keep this draft' }])
    expect((await createSqliteDesktopCompanyProfileStore(reopened, { schemaReady: true }).get(attempt.requestId))?.attempt).toEqual(attempt)
    expect((await reopened.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
test('a conflicting migration34 identity refuses before creating profile tables', async () => {
    const { db } = await fixture()
    await db.execute("INSERT INTO desktop_schema_migrations VALUES(34,'another-owner')")
    await expect(initializeDesktopRound37(db)).rejects.toThrow('Desktop migration identity mismatch')
    expect((await db.execute("SELECT name FROM sqlite_master WHERE name='desktop_company_profile_attempts'")).rows).toEqual([])
    expect((await db.execute('SELECT text FROM original_drafts')).rows[0].text).toBe('Keep this draft')
})
