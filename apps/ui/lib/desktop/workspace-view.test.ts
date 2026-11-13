import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { initializeDesktopRound59 } from './server/round59-schema'
import { readDesktopWorkspaceView, saveDesktopWorkspaceView } from './server/workspace-view'
import { desktopSimpleInitialOpen, desktopWorkspaceViewChangeSchema, resolveDesktopWorkspaceView } from './workspace-view'

vi.mock('server-only', () => ({}))

test('the view is the board until Simple is chosen, and each choice is kept with the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-desktop-view-'))
    const db = createClient({ url: `file:${join(root, 'app.db')}` })
    try {
        await db.execute('CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE)')
        await initializeDesktopRound59(db)
        await initializeDesktopRound59(db)
        expect(await readDesktopWorkspaceView(db)).toEqual({ view: null, lastOpened: null })
        expect(resolveDesktopWorkspaceView({ preference: null, placing: false })).toBe('board')
        const ann = randomUUID()
        expect(await saveDesktopWorkspaceView(db, { view: 'simple' })).toEqual({ view: 'simple', lastOpened: null })
        // Remembering the open coworker keeps the view, and choosing a view keeps the coworker.
        expect(await saveDesktopWorkspaceView(db, { lastOpened: ann })).toEqual({ view: 'simple', lastOpened: ann })
        expect(await saveDesktopWorkspaceView(db, { view: 'board' })).toEqual({ view: 'board', lastOpened: ann })
        expect(desktopWorkspaceViewChangeSchema.safeParse({ view: 'grid' }).success).toBe(false)
        expect(desktopWorkspaceViewChangeSchema.safeParse({ lastOpened: 'not-an-id' }).success).toBe(false)
        expect(desktopWorkspaceViewChangeSchema.safeParse({}).success).toBe(false)
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test('placing on the grid shows the board and the preference comes back afterwards', () => {
    expect(resolveDesktopWorkspaceView({ preference: 'simple', placing: true })).toBe('board')
    expect(resolveDesktopWorkspaceView({ preference: 'simple', placing: false })).toBe('simple')
})

test('opens the coworker open last while it still exists, else the most recently active one', () => {
    expect(desktopSimpleInitialOpen({ remembered: 'ann', agentIds: ['ann', 'bo'], mostRecent: 'bo' })).toBe('ann')
    expect(desktopSimpleInitialOpen({ remembered: 'gone', agentIds: ['ann', 'bo'], mostRecent: 'bo' })).toBe('bo')
    expect(desktopSimpleInitialOpen({ remembered: null, agentIds: [], mostRecent: null })).toBeNull()
})
