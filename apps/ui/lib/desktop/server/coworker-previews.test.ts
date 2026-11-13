import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { readDesktopCoworkerPreviews } from './coworker-previews'

test('returns each coworker\'s most recently touched conversation, and none for a coworker being removed', async () => {
    const db = createClient({ url: ':memory:' })
    try {
        await db.executeMultiple(`
            CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id INTEGER NOT NULL);
            CREATE TABLE desktop_deletions (agent_id TEXT NOT NULL, completed INTEGER NOT NULL);
            CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL);`)
        const [ann, bo, quiet, leaving, foreign] = Array.from({ length: 5 }, () => randomUUID())
        await db.batch([ann, bo, quiet, leaving, foreign].map((id, index) => ({ sql: 'INSERT INTO desktop_agents VALUES(?,?,?)', args: [id, 'Coworker', index === 4 ? 2 : 1] })), 'write')
        await db.execute({ sql: 'INSERT INTO desktop_deletions VALUES(?,0)', args: [leaving] })
        const session = (id: string, agent: string, title: string, at: string) => ({ sql: 'INSERT INTO desktop_sessions VALUES(?,?,?,?)', args: [id, agent, title, at] })
        await db.batch([
            session('a1', ann, 'Older', '2026-11-12T09:00:00.000Z'), session('a2', ann, 'Q4 prospects', '2026-11-13T10:00:00.000Z'),
            session('b1', bo, 'Tie, lower id', '2026-11-13T08:00:00.000Z'), session('b2', bo, 'Tie, higher id', '2026-11-13T08:00:00.000Z'),
            session('l1', leaving, 'Leaving', '2026-11-13T11:00:00.000Z'), session('f1', foreign, 'Other workspace', '2026-11-13T12:00:00.000Z'),
        ], 'write')
        expect(await readDesktopCoworkerPreviews(db)).toEqual({ previews: {
            [ann]: { title: 'Q4 prospects', updatedAt: '2026-11-13T10:00:00.000Z' },
            [bo]: { title: 'Tie, higher id', updatedAt: '2026-11-13T08:00:00.000Z' },
        } })
    } finally { db.close() }
})
