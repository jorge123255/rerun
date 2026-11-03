import 'server-only'
import type { Client, Row } from '@libsql/client'

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

export type DesktopConnection = { id: string; provider: 'openai'; name: string }

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
    const [profile, workspace, agents, connections] = await Promise.all([
        db.execute('SELECT id, display_name FROM desktop_profile WHERE id = 1'),
        db.execute('SELECT id, name FROM desktop_workspace WHERE id = 1'),
        listDesktopAgents(db),
        listDesktopConnections(db),
    ])
    return {
        profile: { id: 1, displayName: String(profile.rows[0].display_name) },
        workspace: { id: 1, name: String(workspace.rows[0].name) },
        agents,
        connections,
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

export async function createDesktopSession(db: Client, input: { agentId: string; engineSessionId: string; title: string }): Promise<DesktopSession> {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.execute({
        sql: 'INSERT INTO desktop_sessions (id, agent_id, engine_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [id, input.agentId, input.engineSessionId, input.title.slice(0, 80) || 'New conversation', now, now],
    })
    return (await findDesktopSession(db, id))!
}

export async function saveDesktopConnection(db: Client, connection: DesktopConnection): Promise<void> {
    await db.execute({
        sql: `INSERT INTO desktop_connections (id, workspace_id, provider, name, created_at) VALUES (?, 1, ?, ?, ?)
              ON CONFLICT(provider) DO UPDATE SET id = excluded.id, name = excluded.name`,
        args: [connection.id, connection.provider, connection.name, new Date().toISOString()],
    })
}

export async function listDesktopConnections(db: Client): Promise<DesktopConnection[]> {
    const result = await db.execute('SELECT id, provider, name FROM desktop_connections ORDER BY name')
    return result.rows.map(row => ({ id: String(row.id), provider: 'openai', name: String(row.name) }))
}
