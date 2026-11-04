import 'server-only'
import type { Client, Row } from '@libsql/client'
import { z } from 'zod'
import { allocateHandle } from '@/lib/agent-handle'
import { duplicateAgentName } from '@/lib/copy-name'
import { duplicateAgent, EngineRequestError, getAgent, request } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { canPlaceDesktopCopy, desktopBoardLayout, type DesktopBoardPosition } from '../board-layout'
import { DesktopHttpError } from './auth'
import { withRosterWrite } from './roster-writes'
import { findDesktopAgent, listDesktopAgents, type DesktopAgent } from './store'

export class PositionOccupied extends DesktopHttpError {
    constructor() { super(409, 'That spot is no longer available. Choose another.') }
}
const engineIndex = z.object({ agents: z.array(z.object({ id: z.string(), name: z.string() })) })
const unavailable = 'Could not confirm the coworker copy. Retry this placement.'

async function publishCopy(db: Client, engine: EngineConnection, source: DesktopAgent, receipt: Row) {
    const copyId = String(receipt.agent_id)
    const existing = await findDesktopAgent(db, copyId)
    if (existing) return existing
    if (receipt.completed) throw new DesktopHttpError(404, 'Copied coworker not found')
    const requestId = String(receipt.request_id)
    const name = String(receipt.name)
    const handle = String(receipt.handle)
    let copy
    try {
        copy = await duplicateAgent(engine, source.engineAgentId, { name: handle, displayName: name }, requestId)
    } catch (error) {
        if (error instanceof EngineRequestError && (error.status === 400 || error.status === 404)) {
            // The engine rejected the request before committing a copy. Release this spot.
            await db.execute({ sql: 'DELETE FROM desktop_duplicates WHERE request_id = ? AND completed = 0', args: [requestId] })
            throw new DesktopHttpError(error.status, error.status === 404 ? 'Source coworker not found' : 'Could not safely copy this coworker’s files.')
        }
        throw new DesktopHttpError(502, unavailable)
    }
    if (copy.id !== `copy-${requestId}` || copy.name !== handle || copy.displayName !== name) throw new DesktopHttpError(502, unavailable)
    // The original duplicate preserves enabled along with the rest of its configuration. Read
    // the completed copy itself, since its source may have changed while a lost reply recovered.
    const detail = await getAgent(engine, copy.id).catch(() => { throw new DesktopHttpError(502, unavailable) })
    if (detail.id !== copy.id) throw new DesktopHttpError(502, unavailable)
    const now = new Date().toISOString()
    await db.batch([
        { sql: 'INSERT INTO desktop_agents (id,workspace_id,engine_agent_id,name,description,enabled,created_at,updated_at) VALUES (?,1,?,?,?,?,?,?)',
          args: [copyId, copy.id, name, copy.description || source.description, Number(detail.config.enabled), now, now] },
        { sql: 'UPDATE desktop_duplicates SET completed = 1 WHERE request_id = ?', args: [requestId] },
    ], 'write')
    return (await findDesktopAgent(db, copyId))!
}

export function duplicateDesktopCoworker(db: Client, engine: EngineConnection, sourceId: string, requestId: string, position: DesktopBoardPosition) {
    return withRosterWrite(async () => {
        const source = await findDesktopAgent(db, sourceId)
        if (!source) throw new DesktopHttpError(404, 'Source coworker not found')
        const previous = await db.execute({ sql: 'SELECT * FROM desktop_duplicates WHERE request_id = ?', args: [requestId] })
        const receipt = previous.rows[0]
        if (receipt) {
            if (receipt.source_id !== sourceId || receipt.board_col !== position.col || receipt.board_row !== position.row)
                throw new DesktopHttpError(409, 'This placement belongs to another duplicate request.')
            return publishCopy(db, engine, source, receipt)
        }

        const pending = await db.execute('SELECT * FROM desktop_duplicates WHERE completed = 0')
        const layout = desktopBoardLayout(await listDesktopAgents(db))
        for (const row of pending.rows) layout.positions.set(String(row.agent_id), { col: Number(row.board_col), row: Number(row.board_row) })
        if (!canPlaceDesktopCopy(layout, position)) throw new PositionOccupied()
        const index = await request(engine, '/agents', { method: 'GET', cache: 'no-store' }, data => engineIndex.parse(data))
            .catch(() => { throw new DesktopHttpError(502, unavailable) })
        if (!index.agents.some(agent => agent.id === source.engineAgentId)) throw new DesktopHttpError(404, 'Source coworker not found')
        const name = duplicateAgentName(source.name)
        const taken = new Set(index.agents.map(agent => agent.name))
        const renames = await db.execute('SELECT handle FROM desktop_rename_checks')
        for (const row of [...pending.rows, ...renames.rows]) taken.add(String(row.handle))
        const { rows } = await db.execute({
            sql: `INSERT INTO desktop_duplicates (request_id,source_id,agent_id,name,handle,board_col,board_row)
                  VALUES (?,?,?,?,?,?,?) RETURNING *`,
            args: [requestId, sourceId, crypto.randomUUID(), name, allocateHandle(name, taken), position.col, position.row],
        })
        return publishCopy(db, engine, source, rows[0])
    })
}

// A copy is durable from the placement click. If either local process stopped between
// publishing the engine folder and updating the board, replay the same engine operation.
export function reconcileDesktopDuplicates(db: Client, engine: EngineConnection) {
    return withRosterWrite(async () => {
        const { rows } = await db.execute('SELECT * FROM desktop_duplicates WHERE completed = 0 ORDER BY rowid')
        for (const row of rows) {
            const source = await findDesktopAgent(db, String(row.source_id))
            if (source) await publishCopy(db, engine, source, row).catch(() => {})
        }
    })
}
