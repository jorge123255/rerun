import 'server-only'
import type { Client, InStatement, Transaction } from '@libsql/client'
import { agentsOverlap, containerContainsTile, DEFAULT_SPAN } from '@rerun/ui/iso-grid/iso'
import { findRadialRect, rectOnSide, SPACE_GAP } from '@/lib/board/space-layout'
import { desktopBoardLayout, type DesktopBoardPosition } from '../board-layout'
import { desktopSpaceRectSchema, desktopSpaceWriteSchema, type DesktopBoardState, type DesktopSpace, type DesktopSpacePlacement, type DesktopSpaceWrite } from '../spaces'
import { DesktopHttpError } from './auth'
import { withRosterWrite } from './roster-writes'

type Reader = Pick<Client, 'execute'>
type Rect = Pick<DesktopSpace, 'col_start' | 'row_start' | 'col_end' | 'row_end'>
const revisionWrite: InStatement = 'UPDATE desktop_board_state SET revision = revision + 1 WHERE workspace_id = 1'
const pendingMessage = 'Finish the pending coworker copy before changing this Box.'

function fromNewRect(rect: { colStart: number; rowStart: number; colEnd: number; rowEnd: number }): Rect {
    return { col_start: rect.colStart, row_start: rect.rowStart, col_end: rect.colEnd, row_end: rect.rowEnd }
}

function insertSpace(space: DesktopSpace): InStatement {
    return { sql: 'INSERT INTO desktop_spaces (id, workspace_id, name, col_start, row_start, col_end, row_end) VALUES (?,1,?,?,?,?,?)',
        args: [space.id, space.name, space.col_start, space.row_start, space.col_end, space.row_end] }
}

export function desktopPlacementInsert(placement: DesktopSpacePlacement): InStatement {
    return { sql: 'INSERT INTO desktop_space_placements (agent_id, space_id, col, row) VALUES (?,?,?,?)',
        args: [placement.agentId, placement.spaceId, placement.col, placement.row] }
}

export const desktopBoardRevisionWrite = revisionWrite

/** Called once while opening app.db, before routes can use the store. */
export async function initializeDesktopSpaces(db: Client) {
    await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS desktop_spaces (
            id TEXT PRIMARY KEY,
            workspace_id INTEGER NOT NULL REFERENCES desktop_workspace(id),
            name TEXT NOT NULL,
            col_start INTEGER NOT NULL, row_start INTEGER NOT NULL,
            col_end INTEGER NOT NULL, row_end INTEGER NOT NULL,
            CHECK (col_end - col_start >= 3 AND row_end - row_start >= 3)
        );
        CREATE TABLE IF NOT EXISTS desktop_board_state (
            workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
        );
        CREATE TABLE IF NOT EXISTS desktop_space_placements (
            agent_id TEXT PRIMARY KEY REFERENCES desktop_agents(id) ON DELETE CASCADE,
            space_id TEXT NOT NULL REFERENCES desktop_spaces(id) ON DELETE RESTRICT,
            col INTEGER NOT NULL, row INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS desktop_space_members ON desktop_space_placements(space_id);
        CREATE TABLE IF NOT EXISTS desktop_space_writes (
            request_id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            result_revision INTEGER NOT NULL
        );
    `)
    const columns = await db.execute('PRAGMA table_info(desktop_duplicates)')
    // Completed duplicate receipts are immutable tombstones, so their original destination
    // survives a later Box deletion. Live placements carry the foreign key instead.
    if (!columns.rows.some(row => row.name === 'space_id')) await db.execute('ALTER TABLE desktop_duplicates ADD COLUMN space_id TEXT')
    const tx = await db.transaction('write')
    try {
        const initialized = await tx.execute('SELECT 1 FROM desktop_board_state WHERE workspace_id = 1')
        if (!initialized.rows.length) {
            const agents = await tx.execute(`SELECT a.id, d.board_col, d.board_row FROM desktop_agents a
                LEFT JOIN desktop_duplicates d ON d.agent_id = a.id ORDER BY a.created_at, a.id`)
            const layout = desktopBoardLayout(agents.rows.map(row => ({ id: String(row.id),
                ...(row.board_col == null || row.board_row == null ? {} : { position: { col: Number(row.board_col), row: Number(row.board_row) } }),
            })))
            const reservations = await tx.execute('SELECT board_col, board_row FROM desktop_duplicates WHERE completed = 0')
            for (const row of reservations.rows) {
                layout.bounds.col_start = Math.min(layout.bounds.col_start, Number(row.board_col))
                layout.bounds.row_start = Math.min(layout.bounds.row_start, Number(row.board_row))
                layout.bounds.col_end = Math.max(layout.bounds.col_end, Number(row.board_col) + DEFAULT_SPAN - 1)
                layout.bounds.row_end = Math.max(layout.bounds.row_end, Number(row.board_row) + DEFAULT_SPAN - 1)
            }
            const workspace = await tx.execute('SELECT name FROM desktop_workspace WHERE id = 1')
            const space: DesktopSpace = { id: crypto.randomUUID(), name: String(workspace.rows[0]?.name ?? 'My workspace').trim().slice(0, 60) || 'My workspace', ...layout.bounds }
            await tx.execute(insertSpace(space))
            for (const [agentId, position] of layout.positions) await tx.execute(desktopPlacementInsert({ agentId, spaceId: space.id, ...position }))
            await tx.execute({ sql: 'UPDATE desktop_duplicates SET space_id = ? WHERE space_id IS NULL', args: [space.id] })
            await tx.execute('INSERT INTO desktop_board_state (workspace_id, revision) VALUES (1, 0)')
        }
        await tx.commit()
    } finally { tx.close() }
}

async function readState(reader: Reader): Promise<DesktopBoardState> {
    const state = await reader.execute('SELECT revision FROM desktop_board_state WHERE workspace_id = 1')
    const spaces = await reader.execute('SELECT id, name, col_start, row_start, col_end, row_end FROM desktop_spaces WHERE workspace_id = 1 ORDER BY rowid')
    const placements = await reader.execute(`SELECT p.agent_id, p.space_id, p.col, p.row FROM desktop_space_placements p
        JOIN desktop_agents a ON a.id = p.agent_id WHERE a.workspace_id = 1 ORDER BY a.created_at, a.id`)
    return {
        revision: Number(state.rows[0]?.revision ?? 0),
        spaces: spaces.rows.map(row => ({ id: String(row.id), name: String(row.name), col_start: Number(row.col_start), row_start: Number(row.row_start), col_end: Number(row.col_end), row_end: Number(row.row_end) })),
        placements: placements.rows.map(row => ({ agentId: String(row.agent_id), spaceId: String(row.space_id), col: Number(row.col), row: Number(row.row) })),
    }
}

export async function readDesktopBoardState(db: Client | Transaction): Promise<DesktopBoardState> {
    // Bootstrap already owns a read transaction spanning both roster and board. Reuse
    // that snapshot without opening or closing a nested transaction.
    if (!('transaction' in db)) return readState(db)
    const tx = await db.transaction('read')
    try { return await readState(tx) } finally { tx.close() }
}

async function reservations(reader: Reader) {
    const result = await reader.execute(`SELECT agent_id, space_id, board_col, board_row FROM desktop_duplicates WHERE completed = 0
        UNION ALL SELECT agent_id, space_id, board_col, board_row FROM desktop_creations WHERE phase='reserved'`)
    return result.rows.map(row => ({ agentId: String(row.agent_id), spaceId: String(row.space_id), col: Number(row.board_col), row: Number(row.board_row) }))
}

function requireSpace(board: DesktopBoardState, id: string) {
    const space = board.spaces.find(item => item.id === id)
    if (!space) throw new DesktopHttpError(404, 'Box not found. Refresh the board and try again.')
    return space
}

function inside(space: Rect, anchor: DesktopBoardPosition) { return containerContainsTile(space, anchor, DEFAULT_SPAN) }
function vacant(occupied: readonly DesktopBoardPosition[], anchor: DesktopBoardPosition) { return !occupied.some(other => agentsOverlap(other, anchor)) }

// Equivalent to the original row-major, one-cell-step search, without scanning every
// empty cell of a maliciously huge rectangle. Occupied 2×2 tiles block anchor intervals.
export function firstVacantDesktopSpacePosition(space: Rect, occupied: readonly DesktopBoardPosition[]): DesktopBoardPosition | null {
    const rows = [...new Set([space.row_start, ...occupied.map(item => item.row + DEFAULT_SPAN)])]
        .filter(row => row >= space.row_start && row + DEFAULT_SPAN - 1 <= space.row_end).sort((a, b) => a - b)
    for (const row of rows) {
        const intervals = occupied.filter(item => row <= item.row + DEFAULT_SPAN - 1 && row + DEFAULT_SPAN - 1 >= item.row)
            .map(item => ({ start: item.col - DEFAULT_SPAN + 1, end: item.col + DEFAULT_SPAN - 1 })).sort((a, b) => a.start - b.start)
        let col = space.col_start
        for (const interval of intervals) {
            if (interval.end < col) continue
            if (interval.start > col) break
            col = interval.end + 1
        }
        if (col + DEFAULT_SPAN - 1 <= space.col_end) return { col, row }
    }
    return null
}

function rejectOverlap(board: DesktopBoardState, rect: Rect, except?: string) {
    if (board.spaces.some(other => other.id !== except && rect.col_start - SPACE_GAP <= other.col_end && rect.col_end + SPACE_GAP >= other.col_start && rect.row_start - SPACE_GAP <= other.row_end && rect.row_end + SPACE_GAP >= other.row_start))
        throw new DesktopHttpError(409, 'That Box would overlap another Box. Choose another spot.')
}

async function rejectPending(reader: Reader, spaceId: string) {
    const pending = await reader.execute({ sql: `SELECT 1 FROM desktop_duplicates WHERE space_id = ? AND completed = 0
        UNION ALL SELECT 1 FROM desktop_creations WHERE space_id = ? AND phase='reserved' LIMIT 1`, args: [spaceId, spaceId] })
    if (pending.rows.length) throw new DesktopHttpError(409, pendingMessage)
}

async function applyCommand(tx: Transaction, board: DesktopBoardState, command: DesktopSpaceWrite['command']) {
    if (command.kind === 'create') {
        const source = command.sourceId ? requireSpace(board, command.sourceId) : null
        const rect = fromNewRect(source && command.side ? rectOnSide(source, command.side, board.spaces) : findRadialRect(board.spaces))
        if (!desktopSpaceRectSchema.safeParse(rect).success) throw new DesktopHttpError(409, 'There is no room for another Box in this part of the board.')
        rejectOverlap(board, rect)
        await tx.execute(insertSpace({ id: crypto.randomUUID(), name: command.name, ...rect }))
        return
    }
    const space = requireSpace(board, command.spaceId)
    if (command.kind === 'rename') {
        await tx.execute({ sql: 'UPDATE desktop_spaces SET name = ? WHERE id = ?', args: [command.name, space.id] })
        return
    }
    if (command.kind === 'move-agent') {
        const member = board.placements.find(item => item.agentId === command.agentId)
        if (!member) throw new DesktopHttpError(404, 'Coworker not found. Refresh the board and try again.')
        const deleting = await tx.execute({ sql: 'SELECT 1 FROM desktop_deletions WHERE agent_id = ?', args: [command.agentId] })
        if (deleting.rows.length) throw new DesktopHttpError(409, 'Finish deleting this coworker before moving it.')
        const occupied = [...board.placements, ...await reservations(tx)].filter(item => item.agentId !== command.agentId && item.spaceId === space.id)
        const position = command.position ?? firstVacantDesktopSpacePosition(space, occupied)
        if (!position) throw new DesktopHttpError(409, 'That Box has no room left. Free a cell in it first.')
        if (!inside(space, position)) throw new DesktopHttpError(409, 'The coworker must fit inside its Box.')
        if (!vacant(occupied, position)) throw new DesktopHttpError(409, 'That spot is no longer available. Choose another.')
        await tx.execute({ sql: 'UPDATE desktop_space_placements SET space_id = ?, col = ?, row = ? WHERE agent_id = ?', args: [space.id, position.col, position.row, member.agentId] })
        return
    }
    await rejectPending(tx, space.id)
    const members = board.placements.filter(item => item.spaceId === space.id)
    if (command.kind === 'delete') {
        if (command.confirmationName.trim() !== space.name) throw new DesktopHttpError(409, 'Type the Box’s current name to confirm deletion.')
        if (members.length) throw new DesktopHttpError(409, `This Box still holds ${members.length} ${members.length === 1 ? 'coworker' : 'coworkers'}. Move or delete them first.`)
        await tx.execute({ sql: 'DELETE FROM desktop_spaces WHERE id = ?', args: [space.id] })
        return
    }
    const rect = command.rect
    rejectOverlap(board, rect, space.id)
    const moving = command.kind === 'move-space'
    if (moving && (rect.col_end - rect.col_start !== space.col_end - space.col_start || rect.row_end - rect.row_start !== space.row_end - space.row_start))
        throw new DesktopHttpError(400, 'Moving a Box must preserve its size. Use Resize to change its bounds.')
    const delta = { col: moving ? rect.col_start - space.col_start : 0, row: moving ? rect.row_start - space.row_start : 0 }
    const next = members.map(member => ({ ...member, col: member.col + delta.col, row: member.row + delta.row }))
    if (next.some(member => !inside(rect, member))) throw new DesktopHttpError(409, 'The Box must still contain all of its coworkers.')
    await tx.execute({ sql: 'UPDATE desktop_spaces SET col_start = ?, row_start = ?, col_end = ?, row_end = ? WHERE id = ?', args: [rect.col_start, rect.row_start, rect.col_end, rect.row_end, space.id] })
    if (moving) await tx.execute({ sql: 'UPDATE desktop_space_placements SET col = col + ?, row = row + ? WHERE space_id = ?', args: [delta.col, delta.row, space.id] })
}

/** Revision compare, mutation, and receipt are one transaction. A lost response confirms
 * its receipt and returns today's board; a reused UUID with different content never mutates it. */
export function writeDesktopBoardState(db: Client, raw: DesktopSpaceWrite, onCommit?: (tx: Transaction, before: DesktopBoardState, after: DesktopBoardState) => Promise<void>): Promise<DesktopBoardState> {
    const parsed = desktopSpaceWriteSchema.safeParse(raw)
    if (!parsed.success) return Promise.reject(new DesktopHttpError(400, 'Choose a valid Box change.'))
    const input = parsed.data
    const fingerprint = JSON.stringify({ expectedRevision: input.expectedRevision, command: input.command })
    return withRosterWrite(async () => {
        const tx = await db.transaction('write')
        try {
            const previous = await tx.execute({ sql: 'SELECT fingerprint FROM desktop_space_writes WHERE request_id = ?', args: [input.requestId] })
            if (previous.rows[0]) {
                if (previous.rows[0].fingerprint !== fingerprint) throw new DesktopHttpError(409, 'This request was already used for another Box change.')
                return await readState(tx)
            }
            const board = await readState(tx)
            if (board.revision !== input.expectedRevision) throw new DesktopHttpError(409, 'The board changed. Refresh it before trying again.')
            if (board.revision >= Number.MAX_SAFE_INTEGER) throw new DesktopHttpError(409, 'The board cannot accept another change.')
            await applyCommand(tx, board, input.command)
            await tx.execute(revisionWrite)
            const result = await readState(tx)
            await onCommit?.(tx, board, result)
            await tx.execute({ sql: 'INSERT INTO desktop_space_writes (request_id, fingerprint, result_revision) VALUES (?,?,?)', args: [input.requestId, fingerprint, result.revision] })
            await tx.commit()
            return result
        } finally { tx.close() }
    })
}

/** Caller owns withRosterWrite. No nested lock: engine creation holds that lock from
 * this capacity check through publishing the local agent and its membership. */
export async function planDesktopAgentPlacement(reader: Reader, requestedSpaceId?: string): Promise<{ space: DesktopSpace; position: DesktopBoardPosition; createSpace: boolean }> {
    const board = await readState(reader)
    const occupied = [...board.placements, ...await reservations(reader)]
    const spaces = requestedSpaceId ? [requireSpace(board, requestedSpaceId)] : board.spaces
    for (const space of spaces) {
        const position = firstVacantDesktopSpacePosition(space, occupied.filter(item => item.spaceId === space.id))
        if (position) return { space, position, createSpace: false }
    }
    if (requestedSpaceId) throw new DesktopHttpError(409, 'That Box has no room left. Free a cell in it first.')
    const rect = fromNewRect(findRadialRect(board.spaces))
    if (!desktopSpaceRectSchema.safeParse(rect).success) throw new DesktopHttpError(409, 'There is no room for another Box in this part of the board.')
    let name = 'New Box'
    for (let number = 2; board.spaces.some(space => space.name === name); number++) name = `New Box ${number}`
    const space = { id: crypto.randomUUID(), name, ...rect }
    return { space, position: { col: space.col_start, row: space.row_start }, createSpace: true }
}

export async function insertDesktopAgentWithPlacement(db: Client, input: { id: string; engineAgentId: string; name: string; description: string; now: string; spaceId?: string }) {
    const tx = await db.transaction('write')
    try {
        const plan = await planDesktopAgentPlacement(tx, input.spaceId)
        if (plan.createSpace) await tx.execute(insertSpace(plan.space))
        await tx.execute({ sql: 'INSERT INTO desktop_agents (id, workspace_id, engine_agent_id, name, description, created_at, updated_at) VALUES (?,1,?,?,?,?,?)',
            args: [input.id, input.engineAgentId, input.name, input.description, input.now, input.now] })
        await tx.execute(desktopPlacementInsert({ agentId: input.id, spaceId: plan.space.id, ...plan.position }))
        await tx.execute(revisionWrite)
        await tx.commit()
    } finally { tx.close() }
}

/** Existing duplicate requests may omit a Box. Resolve it by the actual destination
 * cells, never by the source coworker (which may have moved since the copy began). */
export async function desktopDuplicateDestination(db: Client, position: DesktopBoardPosition, requestedSpaceId?: string, reservationAgentId?: string): Promise<string> {
    const board = await readState(db)
    const space = requestedSpaceId ? requireSpace(board, requestedSpaceId) : board.spaces.find(item => inside(item, position))
    if (!space || !inside(space, position)) throw new DesktopHttpError(409, 'Choose a spot inside a Box for this copy.')
    const occupied = [...board.placements, ...await reservations(db)].filter(item => item.spaceId === space.id && item.agentId !== reservationAgentId)
    if (!vacant(occupied, position)) throw new DesktopHttpError(409, 'That spot is no longer available. Choose another.')
    return space.id
}
