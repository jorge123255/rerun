import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { initializeDesktopRound28 } from './round28-schema'
import { initializeDesktopRound31 } from './round31-schema'
import { serviceSkillMigrationSql } from './services/skill-journal'
const folders: string[] = []
const clients: ReturnType<typeof createClient>[] = []
afterEach(async () => { clients.splice(0).forEach(db => db.close()); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
async function previous() {
    const folder = await mkdtemp(join(tmpdir(), 'rerun-round31-migrate-')); folders.push(folder)
    const db = createClient({ url: `file:${join(folder, 'app.db')}` }); clients.push(db)
    await db.executeMultiple("PRAGMA foreign_keys=ON; CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY); CREATE TABLE desktop_composer_drafts(agent_id TEXT,tab_uid TEXT,text TEXT); INSERT INTO desktop_agents VALUES('original'); INSERT INTO desktop_sessions VALUES('original-chat'); INSERT INTO desktop_composer_drafts VALUES('original','tab','Keep this unsent');")
    await initializeDesktopRound28(db)
    return db
}
test('version 5 upgrade preserves original chats and drafts and can be reopened safely', async () => {
    const db = await previous()
    await initializeDesktopRound31(db)
    await initializeDesktopRound31(db)
    expect((await db.execute('SELECT * FROM desktop_agents')).rows).toEqual([{ id: 'original' }])
    expect((await db.execute('SELECT * FROM desktop_sessions')).rows).toEqual([{ id: 'original-chat' }])
    expect((await db.execute('SELECT text,coworker_mentions FROM desktop_composer_drafts')).rows).toEqual([{ text: 'Keep this unsent', coworker_mentions: null }])
    expect((await db.execute('SELECT version FROM desktop_schema_migrations ORDER BY version')).rows.map(row => row.version)).toEqual([2,3,4,5,6,7,8,9])
    expect((await db.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
test('an unversioned earlier app-skill table gains publication identity without losing ownership', async () => {
    const db = await previous()
    await db.executeMultiple(serviceSkillMigrationSql.replace('resource TEXT, publication_name TEXT', 'resource TEXT'))
    await db.execute("INSERT INTO desktop_service_skill_resources(owner,engine_id,installation_id,ordinal,slug,stage_slug,content_hash,state) VALUES('original','engine','install',0,'svc-test','svc-test-pending','hash','reserved')")
    await initializeDesktopRound31(db)
    expect((await db.execute('SELECT owner,state,publication_name FROM desktop_service_skill_resources')).rows).toEqual([{ owner: 'original', state: 'reserved', publication_name: null }])
})
test('a conflicting migration identity refuses instead of rewriting the schema', async () => {
    const db = await previous()
    await db.execute("INSERT INTO desktop_schema_migrations VALUES(6,'foreign-step')")
    await expect(initializeDesktopRound31(db)).rejects.toThrow('identity mismatch')
    expect((await db.execute('SELECT text FROM desktop_composer_drafts')).rows[0]?.text).toBe('Keep this unsent')
})
