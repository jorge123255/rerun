import { AuthorizationError, type WorkspaceContext } from '@/app/api/_auth/ownership'
import { findIdleSessions, resolveAgentTarget } from '@/app/api/_services/chat.service'
import { fetchLiveSessions, sweepZombieSessions } from '@/lib/board/live-sessions'
import { agentFromRow, computeAgentStatus } from '@/lib/board/types'
import { getAgent as engineGetAgent } from '@/lib/engine/client'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'
import type { AgentView, BoardAgent } from '@rerun/contracts'

const AGENT_COLUMNS = ['id', 'name', 'handle', 'description', 'template_id', 'status', 'col', 'row', 'workspace_id', 'space_id', 'disabled_at', 'disabled_reason'] as const

function boardAgentFromRow(row: Parameters<typeof agentFromRow>[0]): BoardAgent {
    const { position: _position, ...agent } = agentFromRow(row)
    return agent
}

// The server side of the board's hydrate: every agent of the workspace with the status its live
// sessions give it. Reachability is not in here, it comes from the health poll, so a Box that does
// not answer never holds up the list.
export async function listBoardAgents(ctx: WorkspaceContext): Promise<BoardAgent[]> {
    const { data, error } = await selectMany(ctx.supabase, 'agents', AGENT_COLUMNS, { workspace_id: ctx.workspace.id }, { column: 'created_at' })
    if (error) throw error
    const agents = (data ?? []).map(boardAgentFromRow)
    if (agents.length === 0) return []

    const sessions = (await fetchLiveSessions(ctx.supabase, agents.map(a => a.id))) ?? []
    await sweepZombieSessions(ctx.supabase, sessions, sessionIds => findIdleSessions(sessionIds, ctx.workspace.id))

    return agents.map(agent => ({ ...agent, status: computeAgentStatus(sessions.filter(s => s.agentId === agent.id), true) }))
}

export async function readAgentView(ctx: WorkspaceContext, agentId: string): Promise<AgentView> {
    const { data: row, error } = await selectMaybeSingle(ctx.supabase, 'agents', AGENT_COLUMNS, { id: agentId })
    if (error) throw error
    if (!row || row.workspace_id !== ctx.workspace.id) throw new AuthorizationError('Coworker not found')

    const agent = boardAgentFromRow(row)
    if (agent.disabledAt) return { agent, detail: null, locked: false }

    const { conn, engineAgentId } = await resolveAgentTarget(agentId, ctx.workspace.id)
    return { agent, detail: await engineGetAgent(conn, engineAgentId), locked: false }
}
