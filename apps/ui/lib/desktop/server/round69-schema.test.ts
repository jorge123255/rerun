import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { initializeDesktopRound68 } from './round68-schema'
import { initializeDesktopRound69 } from './round69-schema'

const roots: string[] = []
const clients: Client[] = []
afterEach(async () => {
    clients.splice(0).forEach(db => db.close())
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-round69-'))
    roots.push(root)
    const db = createClient({ url: `file:${join(root, 'app.db')}` })
    clients.push(db)
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE)')
    return db
}
const rounds = async (db: Client) => (await db.execute('SELECT version, id FROM desktop_schema_migrations WHERE version >= 68 ORDER BY version')).rows
const tables = async (db: Client) => (await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('desktop_speech_settings','desktop_usage_backup_model','desktop_usage_chat_waits') ORDER BY name")).rows.map(row => row.name)
const both = [{ version: 68, id: 'spoken-replies' }, { version: 69, id: 'usage-limit-gate' }]
const all = ['desktop_speech_settings', 'desktop_usage_backup_model', 'desktop_usage_chat_waits']

test('rounds 68 and 69 both apply on a fresh database, and again without change', async () => {
    const db = await fixture()
    await initializeDesktopRound68(db)
    await initializeDesktopRound69(db)
    expect(await rounds(db)).toEqual(both)
    expect(await tables(db)).toEqual(all)
    await initializeDesktopRound68(db)
    await initializeDesktopRound69(db)
    expect(await rounds(db)).toEqual(both)
})

test('round 69 applies on a database that already has spoken replies as round 68, keeping its settings', async () => {
    const db = await fixture()
    await initializeDesktopRound68(db)
    await db.execute("INSERT INTO desktop_speech_settings(id, voice_id, auto_read) VALUES (1, 'voice-a', 1)")
    expect(await rounds(db)).toEqual([both[0]])
    await initializeDesktopRound68(db)
    await initializeDesktopRound69(db)
    expect(await rounds(db)).toEqual(both)
    expect(await tables(db)).toEqual(all)
    expect((await db.execute('SELECT voice_id, auto_read FROM desktop_speech_settings')).rows).toEqual([{ voice_id: 'voice-a', auto_read: 1 }])
    await db.execute("INSERT INTO desktop_usage_backup_model(id, connection_id, model) VALUES (1, 'c', 'm')")
})

test('round 69 refuses a database where another change already took its number', async () => {
    const db = await fixture()
    await db.execute("INSERT INTO desktop_schema_migrations VALUES (69, 'another-owner')")
    await expect(initializeDesktopRound69(db)).rejects.toThrow('Desktop migration identity mismatch')
    expect(await tables(db)).toEqual([])
})
