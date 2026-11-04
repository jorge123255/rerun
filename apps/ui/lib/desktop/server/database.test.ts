import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createClient } from '@libsql/client'
import { findDesktopAgent } from './store'

let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-db-'))
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
})

describe('openDesktopDatabase', () => {
    it('migrates existing coworker rows to enabled without replacing their identity', async () => {
        const old = createClient({ url: `file:${join(root, 'app.db')}` })
        await old.executeMultiple(`CREATE TABLE desktop_agents (
            id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, engine_agent_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            INSERT INTO desktop_agents VALUES ('kept-id', 1, 'kept-engine', 'Existing coworker', '', 'before', 'before');`)
        old.close()
        const db = await openDesktopDatabase(root)
        expect(await findDesktopAgent(db, 'kept-id')).toMatchObject({ engineAgentId: 'kept-engine', enabled: true, updatedAt: 'before' })
        await db.execute("UPDATE desktop_agents SET enabled = 0 WHERE id = 'kept-id'")
        await closeDesktopDatabase(root)
        expect((await findDesktopAgent(await openDesktopDatabase(root), 'kept-id'))?.enabled).toBe(false)
    })
    it('creates a separate app database and idempotent local profile/workspace', async () => {
        const first = await openDesktopDatabase(root)
        const profile = await first.execute('SELECT id, display_name FROM desktop_profile WHERE id = 1')
        const workspace = await first.execute('SELECT id, name, profile_id FROM desktop_workspace WHERE id = 1')
        expect(profile.rows).toHaveLength(1)
        expect(workspace.rows).toHaveLength(1)
        expect(workspace.rows[0].profile_id).toBe(1)
        await stat(join(root, 'app.db'))
        await closeDesktopDatabase(root)

        const second = await openDesktopDatabase(root)
        const profiles = await second.execute('SELECT COUNT(*) AS count FROM desktop_profile')
        const workspaces = await second.execute('SELECT COUNT(*) AS count FROM desktop_workspace')
        expect(Number(profiles.rows[0].count)).toBe(1)
        expect(Number(workspaces.rows[0].count)).toBe(1)
    })
})
