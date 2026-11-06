import 'server-only'
import type { Client, Transaction } from '@libsql/client'
import { agentsOverlap, containerContainsTile, DEFAULT_SPAN } from '@rerun/ui/iso-grid/iso'
import { desktopTemplateCommitInputSchema, type DesktopTemplateCommitInput } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { withRosterWrite } from '../roster-writes'
import { desktopBoardRevisionWrite, desktopPlacementInsert } from '../spaces'

type Anchor = { agentId: string; spaceId: string; col: number; row: number }
type Reader = Pick<Client, 'execute'> | Transaction

async function occupied(reader: Reader, spaceId: string, requestId: string): Promise<Anchor[]> {
    const placements = await reader.execute({ sql: 'SELECT agent_id, space_id, col, row FROM desktop_space_placements WHERE space_id = ?', args: [spaceId] })
    const duplicates = await reader.execute({ sql: 'SELECT agent_id, space_id, board_col AS col, board_row AS row FROM desktop_duplicates WHERE completed = 0 AND space_id = ?', args: [spaceId] })
    const creations = await reader.execute({ sql: `SELECT agent_id, space_id, board_col AS col, board_row AS row FROM desktop_creations WHERE phase = 'reserved' AND space_id = ?`, args: [spaceId] })
    const anchors = [...placements.rows, ...duplicates.rows, ...creations.rows].map(row => ({
        agentId: String(row.agent_id), spaceId: String(row.space_id), col: Number(row.col), row: Number(row.row),
    }))
    const pending = await reader.execute({ sql: `SELECT request_id, payload FROM desktop_template_requests WHERE operation = 'install' AND status NOT IN ('installed','refused') AND request_id != ?`, args: [requestId] })
    for (const row of pending.rows) {
        const payload = JSON.parse(String(row.payload)) as { spaceId?: string; coworkers?: { agentId: string; position: { col: number; row: number } }[] }
        if (payload.spaceId !== spaceId) continue
        for (const coworker of payload.coworkers ?? []) anchors.push({ agentId: coworker.agentId, spaceId, col: coworker.position.col, row: coworker.position.row })
    }
    return anchors
}

async function assertVacant(reader: Reader, parsed: DesktopTemplateCommitInput): Promise<void> {
    const spaces = await reader.execute({ sql: 'SELECT col_start, row_start, col_end, row_end FROM desktop_spaces WHERE id = ? AND workspace_id = 1', args: [parsed.spaceId] })
    const space = spaces.rows[0]
    if (!space) throw new DesktopHttpError(404, 'Box not found. Refresh the board and try again.')
    const rect = { col_start: Number(space.col_start), row_start: Number(space.row_start), col_end: Number(space.col_end), row_end: Number(space.row_end) }
    const ours = new Map(parsed.coworkers.map(coworker => [coworker.agentId, coworker]))
    const taken = (await occupied(reader, parsed.spaceId, parsed.requestId)).filter(anchor => {
        const wanted = ours.get(anchor.agentId)
        if (!wanted) return true
        if (wanted.position.col !== anchor.col || wanted.position.row !== anchor.row) throw new DesktopHttpError(409, 'This install was already placed somewhere else')
        return false
    })
    parsed.coworkers.forEach((coworker, index) => {
        if (!containerContainsTile(rect, coworker.position, DEFAULT_SPAN)) throw new DesktopHttpError(409, 'Choose a spot inside a Box for this template.')
        if (taken.some(anchor => agentsOverlap(anchor, coworker.position))) throw new DesktopHttpError(409, 'That spot is no longer available. Choose another.')
        if (parsed.coworkers.slice(0, index).some(other => agentsOverlap(other.position, coworker.position))) throw new DesktopHttpError(409, 'That spot is no longer available. Choose another.')
    })
}

function parsedCommit(input: DesktopTemplateCommitInput & { signal?: AbortSignal }): DesktopTemplateCommitInput {
    const { signal, ...body } = input
    if (signal?.aborted) throw new DesktopHttpError(408, 'Template install was cancelled')
    return desktopTemplateCommitInputSchema.parse(body)
}

// Read-only spot check. The install server runs this before the engine creates folders.
export function preflightDesktopTemplateInstall(db: Client, input: DesktopTemplateCommitInput & { signal?: AbortSignal }): Promise<void> {
    const parsed = parsedCommit(input)
    return withRosterWrite(async () => {
        const tx = await db.transaction('read')
        try { await assertVacant(tx, parsed) } finally { tx.close() }
    })
}

export function commitDesktopTemplateInstall(db: Client, input: DesktopTemplateCommitInput & { signal?: AbortSignal }, internal?: { enabled: false; onCommit?: (tx: Transaction) => Promise<void> }): Promise<{ acknowledged: true }> {
    const parsed = parsedCommit(input)
    return withRosterWrite(async () => {
        const tx = await db.transaction('write')
        try {
            const request = (await tx.execute({ sql:'SELECT payload FROM desktop_template_requests WHERE request_id=? AND receipt_id=?',args:[parsed.requestId,parsed.receiptId] })).rows[0]
            if (request && JSON.parse(String(request.payload)).rollback) throw new DesktopHttpError(409, 'This installation was cancelled')
            await assertVacant(tx, parsed)
            const now = new Date().toISOString()
            for (const coworker of parsed.coworkers) {
                const existing = await tx.execute({ sql: 'SELECT engine_agent_id, name FROM desktop_agents WHERE id = ?', args: [coworker.agentId] })
                const row = existing.rows[0]
                if (row) {
                    if (internal) throw new DesktopHttpError(409, 'This Foreman install would adopt an existing coworker')
                    if (String(row.engine_agent_id) !== coworker.engineAgentId || String(row.name) !== coworker.name) throw new DesktopHttpError(409, 'This install receipt already belongs to another coworker')
                    continue
                }
                await tx.execute({
                    sql: 'INSERT INTO desktop_agents (id, workspace_id, engine_agent_id, name, description, enabled, created_at, updated_at) VALUES (?,1,?,?,?,?,?,?)',
                    args: [coworker.agentId, coworker.engineAgentId, coworker.name, coworker.description, internal?.enabled === false || coworker.enabled === false ? 0 : 1, now, now],
                })
                await tx.execute(desktopPlacementInsert({ agentId: coworker.agentId, spaceId: parsed.spaceId, col: coworker.position.col, row: coworker.position.row }))
            }
            await tx.execute({
                sql: `UPDATE desktop_template_requests SET status = 'installed', template_id = ?, revision = ?, updated_at = ? WHERE request_id = ? AND receipt_id = ?`,
                args: [parsed.templateId, parsed.revision, now, parsed.requestId, parsed.receiptId],
            })
            await tx.execute(desktopBoardRevisionWrite)
            await internal?.onCommit?.(tx)
            await tx.commit()
            return { acknowledged: true as const }
        } finally { tx.close() }
    })
}
