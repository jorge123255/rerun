import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'

let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-db-'))
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
})

describe('openDesktopDatabase', () => {
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
