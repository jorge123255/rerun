import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test } from 'vitest'
import { initializeDesktopRound38 } from './round38-schema'

const roots: string[] = []
const clients: Client[] = []
afterEach(async () => {
    clients.splice(0).forEach(db => db.close())
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-general-migration-'))
    roots.push(root)
    const db = createClient({ url: `file:${join(root, 'app.db')}` })
    clients.push(db)
    await db.executeMultiple(`
        CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE);
        INSERT INTO desktop_schema_migrations VALUES (35, 'fx-board-camera');
        CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);
        INSERT INTO desktop_agents VALUES ('ada'), ('bea');
        CREATE TABLE desktop_sessions(
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            engine_session_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO desktop_sessions VALUES
            ('notes', 'ada', 'engine-notes', 'Daily notes', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
            ('plan', 'bea', 'engine-plan', 'Launch plan', '2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    `)
    return db
}

test('existing chats stay threads with their titles, and only one General can be saved per coworker', async () => {
    const db = await fixture()
    await initializeDesktopRound38(db)
    await initializeDesktopRound38(db)
    const saved = await db.execute('SELECT id, agent_id, title, kind, first_message FROM desktop_sessions ORDER BY id')
    expect(saved.rows).toEqual([
        { id: 'notes', agent_id: 'ada', title: 'Daily notes', kind: 'thread', first_message: null },
        { id: 'plan', agent_id: 'bea', title: 'Launch plan', kind: 'thread', first_message: null },
    ])
    await db.execute("INSERT INTO desktop_sessions(id, agent_id, engine_session_id, title, created_at, updated_at, kind) VALUES ('g-ada', 'ada', 'engine-g-ada', 'General', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', 'general')")
    await db.execute("INSERT INTO desktop_sessions(id, agent_id, engine_session_id, title, created_at, updated_at, kind) VALUES ('g-bea', 'bea', 'engine-g-bea', 'General', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', 'general')")
    await expect(db.execute("INSERT INTO desktop_sessions(id, agent_id, engine_session_id, title, created_at, updated_at, kind) VALUES ('g-ada-2', 'ada', 'engine-g-ada-2', 'General', '2026-11-06T00:00:00.000Z', '2026-11-06T00:00:00.000Z', 'general')")).rejects.toThrow()
    expect((await db.execute("SELECT id FROM desktop_sessions WHERE agent_id = 'ada' AND kind = 'general'")).rows.map(row => row.id)).toEqual(['g-ada'])
    expect((await db.execute('SELECT id FROM desktop_schema_migrations WHERE version = 36')).rows).toEqual([{ id: 'coworker-general-threads' }])
})

test('a conflicting migration identity leaves saved chats untouched', async () => {
    const db = await fixture()
    await db.execute("INSERT INTO desktop_schema_migrations VALUES (36, 'another-owner')")
    await expect(initializeDesktopRound38(db)).rejects.toThrow('Desktop migration identity mismatch')
    expect((await db.execute('PRAGMA table_info(desktop_sessions)')).rows.map(row => row.name)).not.toContain('kind')
    expect((await db.execute('SELECT title FROM desktop_sessions WHERE id = \'notes\'')).rows[0].title).toBe('Daily notes')
})
