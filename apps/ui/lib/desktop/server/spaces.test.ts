import { createClient, type Client } from '@libsql/client'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { desktopBoardLayout } from '../board-layout'
import { desktopBoardStateSchema, type DesktopSpaceCommand, type DesktopSpaceWrite } from '../spaces'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, listDesktopSessions, readDesktopBootstrap } from './store'
import { desktopDuplicateDestination, firstVacantDesktopSpacePosition, readDesktopBoardState, writeDesktopBoardState } from './spaces'

let root: string, db: Client
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rerun-desktop-boxes-')); db = await openDesktopDatabase(root) })
afterEach(async () => { await closeDesktopDatabase(root); await closeDesktopDatabase(join(root, 'legacy')); await rm(root, { recursive: true, force: true }) })
const board = () => readDesktopBoardState(db)
async function command(command: DesktopSpaceCommand) {
    return writeDesktopBoardState(db, { requestId: crypto.randomUUID(), expectedRevision: (await board()).revision, command })
}
async function newBox(name = 'Research') {
    const previous = await board()
    const next = await command({ kind: 'create', name })
    return next.spaces.find(space => !previous.spaces.some(old => old.id === space.id))!
}

it('migrates the exact synthetic layout and duplicate reservations once without changing agents or chats', async () => {
    const legacyRoot = join(root, 'legacy')
    await mkdir(legacyRoot)
    const legacy = createClient({ url: `file:${join(legacyRoot, 'app.db')}` })
    await legacy.executeMultiple(`
        CREATE TABLE desktop_profile (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_workspace (id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, engine_agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_duplicates (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, handle TEXT NOT NULL, board_col INTEGER NOT NULL, board_row INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
        INSERT INTO desktop_profile VALUES (1, 'Original User', 'old', 'old');
        INSERT INTO desktop_workspace VALUES (1, 1, 'Original team', 'old', 'old');
    `)
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    for (let index = 0; index < ids.length; index++) await legacy.execute({ sql: 'INSERT INTO desktop_agents VALUES (?,1,?,?,?,?,?,?)', args: [ids[index]!, `engine-${index}`, `Coworker ${index}`, 'Original instructions stay in the engine', index === 1 ? 0 : 1, `old-${index}`, `old-${index}`] })
    const completedId = crypto.randomUUID(), pendingId = crypto.randomUUID()
    await legacy.execute({ sql: 'INSERT INTO desktop_duplicates VALUES (?,?,?,?,?,?,?,1)', args: [completedId, ids[0]!, ids[2]!, 'Coworker 2', 'copy', 1, 1] })
    const expected = desktopBoardLayout([{ id: ids[0]! }, { id: ids[1]! }, { id: ids[2]!, position: { col: 1, row: 1 } }])
    await legacy.execute({ sql: 'INSERT INTO desktop_duplicates VALUES (?,?,?,?,?,?,?,0)', args: [pendingId, ids[0]!, crypto.randomUUID(), 'Pending copy', 'pending_copy', expected.suggested.col, expected.suggested.row] })
    const untouchedAgents = (await legacy.execute('SELECT * FROM desktop_agents ORDER BY id')).rows
    legacy.close()
    let migrated = await openDesktopDatabase(legacyRoot)
    const original = await readDesktopBoardState(migrated)
    expect(original.revision).toBe(0)
    expect(original.spaces).toEqual([{ id: expect.any(String), name: 'Original team', ...expected.bounds }])
    expect(original.placements).toEqual(ids.map(agentId => ({ agentId, spaceId: original.spaces[0]!.id, ...expected.positions.get(agentId)! })))
    expect((await migrated.execute('SELECT * FROM desktop_agents ORDER BY id')).rows).toEqual(untouchedAgents)
    expect((await migrated.execute('SELECT space_id FROM desktop_duplicates')).rows.every(row => row.space_id === original.spaces[0]!.id)).toBe(true)
    const chat = await createDesktopSession(migrated, { agentId: ids[0]!, engineSessionId: 'old-chat', title: 'Keep history' })
    await closeDesktopDatabase(legacyRoot)
    migrated = await openDesktopDatabase(legacyRoot)
    expect(await readDesktopBoardState(migrated)).toEqual(original)
    expect(await listDesktopSessions(migrated, ids[0]!)).toEqual([chat])
    await expect(writeDesktopBoardState(migrated, { requestId: crypto.randomUUID(), expectedRevision: 0,
        command: { kind: 'move-space', spaceId: original.spaces[0]!.id, rect: { ...expected.bounds, col_start: expected.bounds.col_start + 30, col_end: expected.bounds.col_end + 30 } } })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('pending coworker copy') })
})

it('creates original adjacent rectangles, trims names, and persists rename through bootstrap and reopening', async () => {
    const initial = (await board()).spaces[0]!
    const next = await command({ kind: 'create', name: '  Research  ', sourceId: initial.id, side: 'bottom-right' })
    const added = next.spaces[1]!
    expect(added).toMatchObject({ name: 'Research', col_start: initial.col_end + 2, col_end: initial.col_end + 9 })
    const renamed = await command({ kind: 'rename', spaceId: added.id, name: 'Product' })
    expect(renamed.revision).toBe(2)
    expect((await readDesktopBootstrap(db)).board).toEqual(renamed)
    await closeDesktopDatabase(root); db = await openDesktopDatabase(root)
    expect(await board()).toEqual(renamed)
})

it('deletes only empty Boxes with the current typed name, and allows zero Boxes plus recovery', async () => {
    const initial = (await board()).spaces[0]!
    await expect(command({ kind: 'delete', spaceId: initial.id, confirmationName: 'wrong' })).rejects.toMatchObject({ status: 409 })
    const agent = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Owner', spaceId: initial.id })
    const chat = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'history', title: 'Keep this' })
    await expect(command({ kind: 'delete', spaceId: initial.id, confirmationName: initial.name })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Move or delete') })
    const destination = await newBox()
    await command({ kind: 'move-agent', agentId: agent.id, spaceId: destination.id })
    await command({ kind: 'delete', spaceId: initial.id, confirmationName: initial.name })
    expect(await listDesktopSessions(db, agent.id)).toEqual([chat])
    expect(await findDesktopAgent(db, agent.id)).toMatchObject({ engineAgentId: 'owner', spaceId: destination.id })
    // Simulate the already tested agent-delete projection: its FK removes only membership.
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [agent.id] })
    await command({ kind: 'delete', spaceId: destination.id, confirmationName: destination.name })
    await closeDesktopDatabase(root); db = await openDesktopDatabase(root)
    expect((await board()).spaces).toEqual([])
    const recovered = await newBox('Recovered')
    expect(recovered).toMatchObject({ col_start: 0, row_start: 0, col_end: 7, row_end: 7 })
})

it('moves an entire Box atomically and resizes around absolute coworker anchors without touching identity or chat', async () => {
    const agent = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Owner' })
    const chat = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'chat', title: 'Retained' })
    const original = await board(), source = original.spaces[0]!, anchor = original.placements[0]!
    const rect = { col_start: source.col_start + 20, row_start: source.row_start - 10, col_end: source.col_end + 20, row_end: source.row_end - 10 }
    const moved = await command({ kind: 'move-space', spaceId: source.id, rect })
    expect(moved.placements).toEqual([{ ...anchor, col: anchor.col + 20, row: anchor.row - 10 }])
    const resized = await command({ kind: 'resize-space', spaceId: source.id, rect: { ...rect, col_end: rect.col_end + 4 } })
    expect(resized.placements).toEqual(moved.placements)
    expect(await findDesktopAgent(db, agent.id)).toMatchObject({ engineAgentId: 'owner', position: { col: anchor.col + 20, row: anchor.row - 10 } })
    expect(await listDesktopSessions(db, agent.id)).toEqual([chat])
    await closeDesktopDatabase(root); db = await openDesktopDatabase(root)
    expect(await board()).toEqual(resized)
})

it('rejects overlap, outside/occupied placement, invalid resize, and stale commands without partial writes', async () => {
    const first = await createDesktopAgent(db, { engineAgentId: 'one', name: 'One' })
    const second = await createDesktopAgent(db, { engineAgentId: 'two', name: 'Two' })
    const other = await newBox(), before = await board(), source = before.spaces[0]!
    await expect(command({ kind: 'move-space', spaceId: source.id, rect: { col_start: other.col_start, row_start: other.row_start, col_end: other.col_start + 4, row_end: other.row_start + 4 } })).rejects.toMatchObject({ status: 409 })
    await expect(command({ kind: 'move-agent', agentId: first.id, spaceId: source.id, position: second.position })).rejects.toMatchObject({ status: 409 })
    await expect(command({ kind: 'move-agent', agentId: first.id, spaceId: source.id, position: { col: source.col_end, row: source.row_end } })).rejects.toMatchObject({ status: 409 })
    await expect(command({ kind: 'resize-space', spaceId: source.id, rect: { col_start: source.col_start + 1, row_start: source.row_start, col_end: source.col_end, row_end: source.row_end } })).rejects.toMatchObject({ status: 409 })
    await expect(command({ kind: 'resize-space', spaceId: source.id, rect: { col_start: 1, row_start: 1, col_end: 2, row_end: 2 } })).rejects.toMatchObject({ status: 400 })
    await expect(writeDesktopBoardState(db, { requestId: crypto.randomUUID(), expectedRevision: before.revision - 1, command: { kind: 'rename', spaceId: source.id, name: 'Stale' } })).rejects.toMatchObject({ status: 409 })
    expect(await board()).toEqual(before)
    expect((await db.execute('SELECT * FROM desktop_space_writes')).rows).toHaveLength(1)
})

it('chooses the original first vacant 2×2 slot and reports a full destination', async () => {
    const box = await newBox()
    const rect = { col_start: box.col_start, row_start: box.row_start, col_end: box.col_start + 3, row_end: box.row_start + 3 }
    await command({ kind: 'resize-space', spaceId: box.id, rect })
    const expected = [{ col: rect.col_start, row: rect.row_start }, { col: rect.col_start + 2, row: rect.row_start }, { col: rect.col_start, row: rect.row_start + 2 }, { col: rect.col_start + 2, row: rect.row_start + 2 }]
    for (let index = 0; index < 4; index++) {
        const member = await createDesktopAgent(db, { engineAgentId: `member-${index}`, name: 'Member', spaceId: box.id })
        expect(member.position).toEqual(expected[index])
    }
    const outsider = await createDesktopAgent(db, { engineAgentId: 'outsider', name: 'Outsider' })
    await expect(command({ kind: 'move-agent', agentId: outsider.id, spaceId: box.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('no room') })
    await expect(createDesktopAgent(db, { engineAgentId: 'must-not-exist', name: 'Rejected', spaceId: box.id })).rejects.toMatchObject({ status: 409 })
    expect((await db.execute("SELECT 1 FROM desktop_agents WHERE engine_agent_id = 'must-not-exist'")).rows).toHaveLength(0)
    // No loop over two million columns is needed to find an empty slot.
    expect(firstVacantDesktopSpacePosition({ col_start: -1_000_000, row_start: -1_000_000, col_end: 1_000_000, row_end: 1_000_000 }, [{ col: -1_000_000, row: -1_000_000 }])).toEqual({ col: -999_998, row: -1_000_000 })
})

it('serializes competing revisions and retries a lost response without resurrecting later-deleted Boxes', async () => {
    const before = await board()
    const write: DesktopSpaceWrite = { requestId: crypto.randomUUID(), expectedRevision: before.revision, command: { kind: 'create', name: 'Once' } }
    const results = await Promise.allSettled([writeDesktopBoardState(db, write), writeDesktopBoardState(db, { ...write, requestId: crypto.randomUUID(), command: { kind: 'create', name: 'Conflict' } })])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } })
    const created = (await board()).spaces.find(space => space.name === 'Once')!
    await command({ kind: 'delete', spaceId: created.id, confirmationName: created.name })
    const latest = await board()
    await closeDesktopDatabase(root); db = await openDesktopDatabase(root)
    expect(await writeDesktopBoardState(db, write)).toEqual(latest)
    expect(await board()).toEqual(latest)
    await expect(writeDesktopBoardState(db, { ...write, command: { kind: 'create', name: 'Different' } })).rejects.toMatchObject({ status: 409 })
})

it('reserves pending copies against new coworkers and movement, and refuses to orphan a pending destination', async () => {
    const source = await createDesktopAgent(db, { engineAgentId: 'source', name: 'Source' })
    const target = await newBox()
    const reserved = { col: target.col_start, row: target.row_start }
    await db.execute({ sql: 'INSERT INTO desktop_duplicates (request_id,source_id,agent_id,name,handle,board_col,board_row,space_id) VALUES (?,?,?,?,?,?,?,?)',
        args: [crypto.randomUUID(), source.id, crypto.randomUUID(), 'Copy', 'copy', reserved.col, reserved.row, target.id] })
    await expect(desktopDuplicateDestination(db, reserved, target.id)).rejects.toMatchObject({ status: 409 })
    await expect(command({ kind: 'move-agent', agentId: source.id, spaceId: target.id, position: reserved })).rejects.toMatchObject({ status: 409 })
    const created = await createDesktopAgent(db, { engineAgentId: 'new', name: 'New', spaceId: target.id })
    expect(created.position).toEqual({ col: target.col_start + 2, row: target.row_start })
    const before = await board()
    await expect(command({ kind: 'move-space', spaceId: target.id, rect: { ...target, col_start: target.col_start + 50, col_end: target.col_end + 50 } })).rejects.toMatchObject({ status: 400 })
    const rect = { col_start: target.col_start + 50, row_start: target.row_start, col_end: target.col_end + 50, row_end: target.row_end }
    await expect(command({ kind: 'move-space', spaceId: target.id, rect })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('pending coworker copy') })
    await expect(command({ kind: 'delete', spaceId: target.id, confirmationName: target.name })).rejects.toMatchObject({ status: 409 })
    expect(await board()).toEqual(before)
})

it('keeps every new coworker in a durable Box, including generic creation after deleting the last Box', async () => {
    const initial = (await board()).spaces[0]!
    await command({ kind: 'delete', spaceId: initial.id, confirmationName: initial.name })
    const agent = await createDesktopAgent(db, { engineAgentId: 'fresh', name: 'Fresh' })
    const state = desktopBoardStateSchema.parse(await board())
    expect(state.spaces).toHaveLength(1)
    expect(state.placements).toEqual([{ agentId: agent.id, spaceId: state.spaces[0]!.id, col: 0, row: 0 }])
    expect(agent.spaceId).toBe(state.spaces[0]!.id)
    await expect(createDesktopAgent(db, { engineAgentId: 'missing-box', name: 'Bad target', spaceId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 })
})
