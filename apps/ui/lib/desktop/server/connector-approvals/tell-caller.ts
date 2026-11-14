import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { FOREMAN_AGENT_ID, toolLabelOf, type DesktopConnectorApprovalDecision } from '@rerun/contracts'

export type ConnectorCaller = { agentId: string; sessionId: string; targetName: string; foreman: boolean }

/** The coworker (or the Chief of Staff) whose call opened this chat, if a call did. */
export async function connectorCallerOf(db: Client, desktopSessionId: string): Promise<ConnectorCaller | null> {
    let row
    try {
        row = (await db.execute({
            sql: 'SELECT parent_agent_id,parent_session_id,target_name FROM desktop_coworker_calls WHERE target_session_id=? ORDER BY created_at DESC LIMIT 1', args: [desktopSessionId],
        })).rows[0]
    } catch { return null } // No coworker has called another in this profile yet.
    if (!row) return null
    const agentId = String(row.parent_agent_id)
    return { agentId, sessionId: String(row.parent_session_id), targetName: String(row.target_name), foreman: agentId === FOREMAN_AGENT_ID }
}

/** What the caller is told. It did not see the card, so the note says what was asked, the answer, and where the work continues. */
export function connectorCallerNote(tool: string, decision: DesktopConnectorApprovalDecision, targetName: string): string {
    const action = toolLabelOf(tool)
    return decision === 'deny'
        ? `Rerun note: the person declined "${action}" for ${targetName}. It did not run. Do not ask ${targetName} to try it again unless the person asks.`
        : `Rerun note: the person allowed "${action}" for ${targetName}. ${targetName} is running it now in its own chat; its result is there, not here. Tell the person briefly that it is under way.`
}

export type TellCallerPorts = {
    /** Starts a turn in a coworker's chat with this text. */
    coworker(agentId: string, sessionId: string, text: string): Promise<void>
    /** Starts a turn in a Chief of Staff conversation with this text. */
    foreman(chatId: string, requestId: string, text: string): Promise<void>
}

/**
 * After the person answers a held call in a chat that a coworker's call opened, the caller gets a
 * turn telling it the answer. Returns whether there was a caller to tell. A caller that is busy,
 * turned off or gone is simply not told: the answer itself already stands.
 */
export async function tellConnectorCaller(db: Client, desktopSessionId: string, answer: { tool: string; decision: DesktopConnectorApprovalDecision }, ports: TellCallerPorts): Promise<boolean> {
    const caller = await connectorCallerOf(db, desktopSessionId)
    if (!caller) return false
    const text = connectorCallerNote(answer.tool, answer.decision, caller.targetName)
    try {
        if (caller.foreman) await ports.foreman(caller.sessionId, randomUUID(), text)
        else await ports.coworker(caller.agentId, caller.sessionId, text)
        return true
    } catch { return false }
}
