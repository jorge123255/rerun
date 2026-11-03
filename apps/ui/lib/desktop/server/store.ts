import 'server-only'
import { desktopTheme } from '../settings'
import { DesktopHttpError } from './auth'
import type { Client, InStatement, Row } from '@libsql/client'

export type DesktopAgent = {
    id: string
    workspaceId: number
    engineAgentId: string
    name: string
    description: string
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
}

function agentOf(row: Row): DesktopAgent {
    return {
        id: String(row.id),
        workspaceId: Number(row.workspace_id),
        engineAgentId: String(row.engine_agent_id),
        name: String(row.name),
        description: String(row.description),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

function sessionOf(row: Row): DesktopSession {
    return {
        id: String(row.id),
        agentId: String(row.agent_id),
        engineSessionId: String(row.engine_session_id),
        title: String(row.title),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

export async function readDesktopBootstrap(db: Client) {
    const [profile, workspace, agents, appearance] = await Promise.all([
        db.execute('SELECT id, display_name FROM desktop_profile WHERE id = 1'),
        db.execute('SELECT id, name FROM desktop_workspace WHERE id = 1'),
        listDesktopAgents(db),
        db.execute('SELECT theme FROM desktop_appearance WHERE workspace_id = 1'),
    ])
    return {
        profile: { id: 1, displayName: String(profile.rows[0].display_name) },
        workspace: { id: 1, name: String(workspace.rows[0].name) },
        agents,
        theme: desktopTheme.parse(appearance.rows[0]?.theme ?? 'system'),
    }
}

export async function listDesktopAgents(db: Client): Promise<DesktopAgent[]> {
    const result = await db.execute('SELECT * FROM desktop_agents ORDER BY created_at, id')
    return result.rows.map(agentOf)
}

export async function findDesktopAgent(db: Client, id: string): Promise<DesktopAgent | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_agents WHERE id = ? AND workspace_id = 1', args: [id] })
    return result.rows[0] ? agentOf(result.rows[0]) : null
}

export async function createDesktopAgent(db: Client, input: { engineAgentId: string; name: string; description?: string }): Promise<DesktopAgent> {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.execute({
        sql: 'INSERT INTO desktop_agents (id, workspace_id, engine_agent_id, name, description, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)',
        args: [id, input.engineAgentId, input.name, input.description ?? '', now, now],
    })
    return (await findDesktopAgent(db, id))!
}

export async function listDesktopSessions(db: Client, agentId: string): Promise<DesktopSession[]> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_sessions WHERE agent_id = ? ORDER BY updated_at DESC, rowid DESC', args: [agentId] })
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

export async function createDesktopSession(db: Client, input: { agentId: string; engineSessionId: string; title: string; regenerationRequestId?: string }): Promise<DesktopSession> {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const statements: InStatement[] = [{
        sql: 'INSERT INTO desktop_sessions (id, agent_id, engine_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(engine_session_id) DO NOTHING',
        args: [id, input.agentId, input.engineSessionId, input.title.slice(0, 80) || 'New conversation', now, now],
    }]
    if (input.regenerationRequestId) statements.push({
        sql: `UPDATE desktop_regeneration_requests SET alternate_session_id =
                  (SELECT id FROM desktop_sessions WHERE engine_session_id = ? AND agent_id = ?)
              WHERE request_id = ? AND alternate_session_id IS NULL`,
        args: [input.engineSessionId, input.agentId, input.regenerationRequestId],
    })
    // A retry can recover an engine fork that was already registered before the response was lost.
    statements.push({ sql: 'SELECT * FROM desktop_sessions WHERE engine_session_id = ? AND agent_id = ?', args: [input.engineSessionId, input.agentId] })
    const results = await db.batch(statements, 'write')
    const row = results.at(-1)!.rows[0]
    if (!row) throw new Error('Engine conversation belongs to another coworker')
    return sessionOf(row)
}
