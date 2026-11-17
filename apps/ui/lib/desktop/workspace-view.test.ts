import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { initializeDesktopRound59 } from './server/round59-schema'
import { initializeDesktopRound72 } from './server/round72-schema'
import { readDesktopSidebarList, readDesktopWorkspaceView, saveDesktopSidebarList, saveDesktopWorkspaceView } from './server/workspace-view'
import { desktopSidebarListChangeSchema, desktopSidebarSections, desktopSimpleInitialOpen, desktopWorkspaceViewChangeSchema, resolveDesktopWorkspaceView } from './workspace-view'

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

async function listDatabase(run: (db: ReturnType<typeof createClient>, reopen: () => ReturnType<typeof createClient>) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-desktop-list-'))
    const url = `file:${join(root, 'app.db')}`
    const opened = [createClient({ url })]
    try {
        await opened[0].execute('CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE)')
        await initializeDesktopRound72(opened[0])
        await initializeDesktopRound72(opened[0])
        await run(opened[0], () => { const next = createClient({ url }); opened.push(next); return next })
    } finally { for (const db of opened) db.close(); await rm(root, { recursive: true, force: true }) }
}

test('lists every Box in the board\'s order, an empty one too, its coworkers in the order they were made', () => {
    const agent = (id: string, createdAt: string, name = id) => ({ id, name, createdAt })
    const home: Record<string, string | null> = { zoe: 'b', ana: 'b', max: 'a', old: 'gone', new: null }
    const { sections, loose } = desktopSidebarSections([agent('zoe', '2026-11-03'), agent('ana', '2026-11-02'), agent('max', '2026-11-01'), agent('old', '2026-10-01'), agent('new', '2026-12-01')],
        [{ id: 'b' }, { id: 'c' }, { id: 'a' }], id => home[id] ?? null)
    expect(sections.map(section => [section.box.id, section.members.map(member => member.id)])).toEqual([['b', ['ana', 'zoe']], ['c', []], ['a', ['max']]])
    // In a Box that is gone, or in none: still listed, never dropped.
    expect(loose.map(member => member.id)).toEqual(['old', 'new'])
})

test('the Boxes folded away are kept with the workspace and survive a restart', async () => {
    await listDatabase(async (db, reopen) => {
        const sales = randomUUID(), support = randomUUID()
        // A profile from before this list existed opens with nothing folded.
        expect(await readDesktopSidebarList(db)).toMatchObject({ collapsed: [] })
        expect((await saveDesktopSidebarList(db, { kind: 'collapsed', ids: [sales, support, sales] })).collapsed.sort()).toEqual([sales, support].sort())
        expect((await readDesktopSidebarList(reopen())).collapsed.sort()).toEqual([sales, support].sort())
        expect((await saveDesktopSidebarList(db, { kind: 'collapsed', ids: [support] })).collapsed).toEqual([support])
        expect(desktopSidebarListChangeSchema.safeParse({ kind: 'collapsed', ids: ['not-an-id'] }).success).toBe(false)
        expect(desktopSidebarListChangeSchema.safeParse({ kind: 'folded', ids: [] }).success).toBe(false)
    })
})
