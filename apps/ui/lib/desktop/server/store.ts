import 'server-only'
import type { DesktopBoardPosition } from '../board-layout'
import { desktopTheme } from '../settings'
import { DesktopHttpError } from './auth'
import type { Client, InStatement, Row } from '@libsql/client'
import { readDesktopRecentCoworkers } from './recent-coworkers'
import { readDesktopWorkspaceIconSelection } from './workspace-icon'
import { insertDesktopAgentWithPlacement, readDesktopBoardState } from './spaces'
import { withRosterWrite } from './roster-writes'
import { FIRST_MESSAGE_MAX_CHARS, GENERAL_SESSION_TITLE, kindOfStoredSession, openingMessage, type DesktopSessionKind } from '../general-threads'

export type DesktopAgent = {
    id: string
    workspaceId: number
    position?: DesktopBoardPosition
    spaceId?: string
    engineAgentId: string
    name: string
    description: string
    enabled: boolean
    createdAt: string
    updatedAt: string
}

export type DesktopSession = {
    id: string
    agentId: string
    engineSessionId: string
    title: string
    createdAt: string
    updatedAt: string
    modelConnectionId: string | null
    model: string | null
    kind?: DesktopSessionKind
    firstMessage?: string | null
}

export class GeneralAlreadyOpenError extends Error {
    readonly session: DesktopSession
    constructor(session: DesktopSession) {
        super('General already open')
        this.name = 'GeneralAlreadyOpenError'
        this.session = session
    }
}

function agentOf(row: Row): DesktopAgent {
    return {
        id: String(row.id),
        workspaceId: Number(row.workspace_id),
        ...(row.board_col == null || row.board_row == null ? {} : { position: { col: Number(row.board_col), row: Number(row.board_row) } }),
        ...(row.space_id == null ? {} : { spaceId: String(row.space_id) }),
        engineAgentId: String(row.engine_agent_id),
        name: String(row.name),
        description: String(row.description),
        enabled: Number(row.enabled) !== 0,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

export function sessionOf(row: Row): DesktopSession {
    const modelConnectionId = row.model_connection_id == null ? null : String(row.model_connection_id)
    const model = row.model == null ? null : String(row.model)
    const choice = modelConnectionId && model ? { modelConnectionId, model } : null
    return {
        id: String(row.id),
        agentId: String(row.agent_id),
        engineSessionId: String(row.engine_session_id),
        title: String(row.title),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        modelConnectionId: choice?.modelConnectionId ?? null,
        model: choice?.model ?? null,
        kind: kindOfStoredSession(row.kind),
        firstMessage: openingMessage(row.first_message == null ? null : String(row.first_message)),
    }
}

export async function readDesktopBootstrap(db: Client) {
    const [profile, workspace, roster, appearance, recentCoworkers, savedIcon] = await Promise.all([
        db.execute('SELECT id, display_name FROM desktop_profile WHERE id = 1'),
        db.execute('SELECT id, name FROM desktop_workspace WHERE id = 1'),
        readDesktopRosterSnapshot(db),
        db.execute('SELECT theme FROM desktop_appearance WHERE workspace_id = 1'),
        readDesktopRecentCoworkers(db),
        readDesktopWorkspaceIconSelection(db),
    ])
    return {
        profile: { id: 1, displayName: String(profile.rows[0].display_name) },
        workspace: { id: 1, name: String(workspace.rows[0].name) },
        agents: roster.agents,
        theme: desktopTheme.parse(appearance.rows[0]?.theme ?? 'system'),
        recentCoworkers,
        board: roster.board,
        ...savedIcon,
    }
}

async function readDesktopRosterSnapshot(db: Client) {
    const tx = await db.transaction('read')
    try {
        // One SQLite snapshot is essential: creating, deleting, or reconciling a
        // coworker changes both tables and the revision in the same write transaction.
        const agents = await listDesktopAgents(tx)
        const board = await readDesktopBoardState(tx)
        return { agents, board }
    } finally { tx.close() }
}

const agentsWithPosition = `SELECT a.*, p.col AS board_col, p.row AS board_row, p.space_id FROM desktop_agents a
    LEFT JOIN desktop_space_placements p ON p.agent_id = a.id`

export async function listDesktopAgents(db: Pick<Client, 'execute'>): Promise<DesktopAgent[]> {
    const result = await db.execute(agentsWithPosition + ' ORDER BY a.created_at, a.id')
    return result.rows.map(agentOf)
}

export async function findDesktopAgent(db: Client, id: string): Promise<DesktopAgent | null> {
    const result = await db.execute({ sql: agentsWithPosition + ' WHERE a.id = ? AND a.workspace_id = 1', args: [id] })
    return result.rows[0] ? agentOf(result.rows[0]) : null
}

type CreateDesktopAgentInput = { engineAgentId: string; name: string; description?: string; spaceId?: string }

export function createDesktopAgent(db: Client, input: CreateDesktopAgentInput): Promise<DesktopAgent> {
    return withRosterWrite(() => createDesktopAgentWithinRosterWrite(db, input))
}

// Engine creation already owns the roster lock, so it calls this non-locking variant.
export async function createDesktopAgentWithinRosterWrite(db: Client, input: CreateDesktopAgentInput): Promise<DesktopAgent> {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await insertDesktopAgentWithPlacement(db, { id, ...input, description: input.description ?? '', now })
    return (await findDesktopAgent(db, id))!
}

export function desktopSessionsQuery(agentId: string) {
    return { sql: `SELECT s.*, t.uid AS first_tab_uid FROM desktop_sessions s LEFT JOIN desktop_tab_starts t
                   ON t.engine_session_id=s.engine_session_id AND t.agent_id=s.agent_id
                   WHERE s.agent_id = ? ORDER BY s.updated_at DESC, s.rowid DESC`, args: [agentId] }
}

export async function listDesktopSessions(db: Client, agentId: string): Promise<DesktopSession[]> {
    const result = await db.execute(desktopSessionsQuery(agentId))
    return result.rows.map(sessionOf)
}

export async function findDesktopSession(db: Client, id: string): Promise<DesktopSession | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_sessions WHERE id = ?', args: [id] })
    return result.rows[0] ? sessionOf(result.rows[0]) : null
}

// Keep one engine request for a reply until its alternate is opened. Remember each browser UUID
// too, so a late duplicate still resolves to the right request after a newer alternate is started.
export async function regenerationRequestId(db: Client, source: string, message: string, request: string): Promise<string> {
    const [, result] = await db.batch([{
        sql: `WITH active AS (
                  SELECT request_id FROM desktop_regeneration_requests WHERE source_session_id = :source AND message_id = :message AND pending = 1
              )
              INSERT INTO desktop_regeneration_requests (request_id, source_session_id, message_id, canonical_id, pending)
              VALUES (:request, :source, :message, COALESCE((SELECT request_id FROM active), :request), NOT EXISTS (SELECT 1 FROM active))
              ON CONFLICT(request_id) DO NOTHING`,
        args: { source, message, request },
    }, {
        sql: 'SELECT source_session_id, message_id, canonical_id FROM desktop_regeneration_requests WHERE request_id = ?',
        args: [request],
    }], 'write')
    const row = result.rows[0]
    if (row.source_session_id !== source || row.message_id !== message) throw new DesktopHttpError(409, 'That retry belongs to a different reply.')
    return String(row.canonical_id)
}

export async function findDesktopGeneralSession(db: Client, agentId: string): Promise<DesktopSession | null> {
    const result = await db.execute({
        sql: `SELECT s.* FROM desktop_sessions s
              JOIN desktop_agents a ON a.id = s.agent_id AND a.workspace_id = 1
              WHERE s.agent_id = ? AND s.kind = 'general'`,
        args: [agentId],
    })
    return result.rows[0] ? sessionOf(result.rows[0]) : null
}

export async function createDesktopSession(db: Client, input: { agentId: string; engineSessionId: string; title: string; regenerationRequestId?: string; model?: { connectionId: string; model: string } | null; kind?: DesktopSessionKind; firstMessage?: string | null }): Promise<DesktopSession> {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const kind = input.kind ?? 'thread'
    const title = (kind === 'general' ? GENERAL_SESSION_TITLE : input.title).slice(0, 80) || 'New conversation'
    const firstMessage = kind === 'general' ? null : openingMessage(input.firstMessage)?.slice(0, FIRST_MESSAGE_MAX_CHARS) ?? null
    const statements: InStatement[] = [{
        sql: `INSERT INTO desktop_sessions (id, agent_id, engine_session_id, title, created_at, updated_at, model_connection_id, model, kind, first_message)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desktop_agents WHERE id = ? AND workspace_id = 1)
                AND NOT EXISTS (SELECT 1 FROM desktop_deletions WHERE agent_id = ?)
                AND (? = 'thread' OR NOT EXISTS (SELECT 1 FROM desktop_sessions WHERE agent_id = ? AND kind = 'general' AND engine_session_id <> ?))
              ON CONFLICT(engine_session_id) DO NOTHING`,
        args: [id, input.agentId, input.engineSessionId, title, now, now, input.model?.connectionId ?? null, input.model?.model ?? null, kind, firstMessage, input.agentId, input.agentId, kind, input.agentId, input.engineSessionId],
    }]
    if (input.regenerationRequestId) statements.push({
        sql: `UPDATE desktop_regeneration_requests SET alternate_session_id =
                  (SELECT id FROM desktop_sessions WHERE engine_session_id = ? AND agent_id = ?)
              WHERE request_id = ? AND alternate_session_id IS NULL`,
        args: [input.engineSessionId, input.agentId, input.regenerationRequestId],
    })
    // A retry can recover an engine fork that was already registered before the response was lost.
    statements.push({ sql: 'SELECT * FROM desktop_sessions WHERE engine_session_id = ? AND agent_id = ?', args: [input.engineSessionId, input.agentId] })
    let results
    try {
        results = await db.batch(statements, 'write')
    } catch (error) {
        if (kind === 'general') {
            const winner = await findDesktopGeneralSession(db, input.agentId)
            if (winner && winner.engineSessionId !== input.engineSessionId) throw new GeneralAlreadyOpenError(winner)
        }
        throw error
    }
    const row = results.at(-1)!.rows[0]
    if (!row) {
        if (kind === 'general') {
            const winner = await findDesktopGeneralSession(db, input.agentId)
            if (winner) throw new GeneralAlreadyOpenError(winner)
        }
        throw new Error('Engine conversation belongs to another coworker')
    }
    const session = sessionOf(row)
    if (session.agentId !== input.agentId || (kind === 'general' && session.kind !== 'general')) throw new Error('Engine conversation belongs to another coworker')
    return session
}

export async function setDesktopSessionModel(db: Client, id: string, pick: { connectionId: string; model: string } | null): Promise<void> {
    await db.execute({
        sql: 'UPDATE desktop_sessions SET model_connection_id = ?, model = ? WHERE id = ?',
        args: [pick?.connectionId ?? null, pick?.model ?? null, id],
    })
}
