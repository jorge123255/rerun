import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { initializeDesktopRound59 } from './server/round59-schema'
import { initializeDesktopRound72 } from './server/round72-schema'
import { readDesktopSidebarList, readDesktopWorkspaceView, saveDesktopSidebarList, saveDesktopWorkspaceView } from './server/workspace-view'
import { applyDesktopSidebarListChange, desktopSidebarListChangeSchema, desktopSidebarOrderWrites, desktopSidebarSections, desktopSidebarStale, emptyDesktopSidebarList, desktopSimpleInitialOpen, desktopWorkspaceViewChangeSchema, resolveDesktopWorkspaceView } from './workspace-view'

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
        expect(await readDesktopSidebarList(db)).toEqual({ collapsed: [], boxes: {}, agents: {} })
        expect((await saveDesktopSidebarList(db, { kind: 'collapsed', ids: [sales, support, sales] })).collapsed.sort()).toEqual([sales, support].sort())
        expect((await readDesktopSidebarList(reopen())).collapsed.sort()).toEqual([sales, support].sort())
        expect((await saveDesktopSidebarList(db, { kind: 'collapsed', ids: [support] })).collapsed).toEqual([support])
        expect(desktopSidebarListChangeSchema.safeParse({ kind: 'collapsed', ids: ['not-an-id'] }).success).toBe(false)
        expect(desktopSidebarListChangeSchema.safeParse({ kind: 'folded', ids: [] }).success).toBe(false)
    })
})

const agent = (id: string, createdAt: string) => ({ id, name: id, createdAt })

test('an arranged list comes first in its order, what nobody placed follows in the order it was made', () => {
    const agents = [agent('ana', '1'), agent('bob', '2'), agent('cyd', '3'), agent('dee', '4')]
    const home: Record<string, string> = { ana: 'a', bob: 'a', cyd: 'a', dee: 'b' }
    const boxes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const read = (list?: Parameters<typeof desktopSidebarSections>[3]) => desktopSidebarSections(agents, boxes, id => home[id] ?? null, list).sections.map(section => [section.box.id, section.members.map(member => member.id)])
    // A profile with nothing arranged reads exactly as it was made.
    expect(read()).toEqual([['a', ['ana', 'bob', 'cyd']], ['b', ['dee']], ['c', []]])
    expect(read({ boxes: {}, agents: {} })).toEqual(read())
    expect(read({ boxes: { c: 1 }, agents: { cyd: { box: 'a', rank: 1 } } })).toEqual([['c', []], ['a', ['cyd', 'ana', 'bob']], ['b', ['dee']]])
    // A rank given in another Box means nothing: the coworker joins the end of the Box it is in.
    expect(read({ boxes: {}, agents: { ana: { box: 'b', rank: 0 }, bob: { box: 'a', rank: 5 } } })).toEqual([['a', ['bob', 'ana', 'cyd']], ['b', ['dee']], ['c', []]])
})

test('a move writes one rank between its neighbours, and numbers the list again only when it has to', () => {
    const placed = [{ id: 'a', order: 1 }, { id: 'b', order: 2 }, { id: 'c', order: 3 }]
    expect(desktopSidebarOrderWrites(placed, 'x', 1)).toEqual([{ id: 'x', order: 1.5 }])
    expect(desktopSidebarOrderWrites(placed, 'x', 0)).toEqual([{ id: 'x', order: 0 }])
    expect(desktopSidebarOrderWrites(placed, 'x', 3)).toEqual([{ id: 'x', order: 4 }])
    expect(desktopSidebarOrderWrites([], 'x', 0)).toEqual([{ id: 'x', order: 1 }])
    // The first time, while some of it was never placed: the whole list, in the order shown.
    expect(desktopSidebarOrderWrites([{ id: 'a', order: null }, { id: 'b', order: undefined }], 'x', 1)).toEqual([{ id: 'a', order: 1 }, { id: 'x', order: 2 }, { id: 'b', order: 3 }])
    // Already numbered as it should be, a neighbour is not written again.
    expect(desktopSidebarOrderWrites([{ id: 'a', order: 1 }, { id: 'b', order: null }], 'x', 1)).toEqual([{ id: 'x', order: 2 }, { id: 'b', order: 3 }])
    // The gap between two neighbours has run out.
    expect(desktopSidebarOrderWrites([{ id: 'a', order: 1 }, { id: 'b', order: 1 + 1e-9 }], 'x', 1)).toEqual([{ id: 'x', order: 2 }, { id: 'b', order: 3 }])
})

test('the saved order survives a restart, and adding or removing a Box or a coworker loses and reorders nothing', async () => {
    await listDatabase(async (db, reopen) => {
        const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()]
        const [ana, bob, cyd, dee] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
        const made = [{ id: ana, name: 'Ana', createdAt: '1' }, { id: bob, name: 'Bob', createdAt: '2' }, { id: cyd, name: 'Cyd', createdAt: '3' }]
        const home: Record<string, string | null> = { [ana]: a, [bob]: a, [cyd]: a }
        // Drag Cyd to the top of Box A (the first time: the Box is numbered), then Box B above Box A.
        const first = desktopSidebarOrderWrites([{ id: ana, order: undefined }, { id: bob, order: undefined }], cyd, 0)
        await saveDesktopSidebarList(db, { kind: 'agents', boxId: a, writes: first })
        await saveDesktopSidebarList(db, { kind: 'boxes', writes: desktopSidebarOrderWrites([{ id: a, order: undefined }], b, 0) })
        const restored = await readDesktopSidebarList(reopen())
        const read = (agents: typeof made, boxes: { id: string }[], list = restored) => desktopSidebarSections(agents, boxes, id => home[id] ?? null, list).sections.map(section => [section.box.id, section.members.map(member => member.name)])
        expect(read(made, [{ id: a }, { id: b }])).toEqual([[b, []], [a, ['Cyd', 'Ana', 'Bob']]])
        // A Box and a coworker added later take the end, without moving anything arranged.
        home[dee] = a
        expect(read([...made, { id: dee, name: 'Dee', createdAt: '4' }], [{ id: a }, { id: b }, { id: c }])).toEqual([[b, []], [a, ['Cyd', 'Ana', 'Bob', 'Dee']], [c, []]])
        // A Box and a coworker removed leave the others where they were.
        expect(read(made.filter(agent => agent.id !== ana), [{ id: a }])).toEqual([[a, ['Cyd', 'Bob']]])
        // Moved to another Box by the board, a coworker joins its end; what it was ranked in the Box it left is forgotten.
        home[cyd] = b
        expect(read(made, [{ id: a }, { id: b }])).toEqual([[b, ['Cyd']], [a, ['Ana', 'Bob']]])
        expect(desktopSidebarStale(restored, [a, b], home)).toEqual({ boxes: [], agents: [cyd] })
        // On its way to that Box after a drag, the rank it was given there is kept.
        const arriving = await saveDesktopSidebarList(db, { kind: 'agents', boxId: b, writes: [{ id: bob, order: 1 }] })
        expect(desktopSidebarStale(arriving, [a, b], home, new Map([[bob, b]])).agents).toEqual([cyd])
        expect(desktopSidebarStale(arriving, [a, b], home).agents.sort()).toEqual([bob, cyd].sort())
        // A Box or a coworker that is gone is forgotten; one the board has in no Box for now is kept.
        await saveDesktopSidebarList(db, { kind: 'collapsed', ids: [a, c] })
        const before = await readDesktopSidebarList(db)
        expect(desktopSidebarStale(before, [a], { [ana]: null, [bob]: b })).toEqual({ boxes: [b, c], agents: [cyd] })
        const after = await saveDesktopSidebarList(db, { kind: 'forget', boxes: [b, c], agents: [cyd] })
        expect(after).toEqual(applyDesktopSidebarListChange(before, { kind: 'forget', boxes: [b, c], agents: [cyd] }))
        expect(after.collapsed).toEqual([a])
        expect(Object.keys(after.boxes)).toEqual([a])
        expect(Object.keys(after.agents).sort()).toEqual([ana, bob].sort())
        // What the screen shows before the answer is what the database then holds.
        const change = { kind: 'agents' as const, boxId: a, writes: [{ id: ana, order: 7.5 }] }
        expect(await saveDesktopSidebarList(db, change)).toEqual(applyDesktopSidebarListChange(after, change))
        expect(desktopSidebarListChangeSchema.safeParse({ kind: 'boxes', writes: [{ id: a, order: Number.NaN }] }).success).toBe(false)
        expect(desktopSidebarListChangeSchema.safeParse({ kind: 'boxes', writes: [] }).success).toBe(false)
        expect(desktopSidebarListChangeSchema.safeParse({ kind: 'agents', writes: [{ id: ana, order: 1 }] }).success).toBe(false)
        expect(applyDesktopSidebarListChange(emptyDesktopSidebarList(), { kind: 'forget', boxes: [], agents: [] })).toEqual(emptyDesktopSidebarList())
    })
})
