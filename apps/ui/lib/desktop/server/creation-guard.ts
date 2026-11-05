import 'server-only'
import type { Client } from '@libsql/client'
import { DesktopHttpError } from './auth'

export const desktopCreationPendingMessage = 'Finish creating this coworker before changing it or sending another message. Resume its first chat from Add coworker.'
type InternalKickoff = {requestId: string; text: string}

/** Human mutations cannot consume the reserved tab or alter its owner before the first turn is
 * confirmed. The optional exception is server-only and must name this owner's exact receipt. */
export async function assertDesktopCreationSettled(db: Client, agentId: string, internalCreationRequestId?: string): Promise<InternalKickoff | null> {
    const result = await db.execute({
        sql: `SELECT request_id,phase,intent FROM desktop_creations WHERE agent_id=?${internalCreationRequestId === undefined ? " AND phase!='started'" : ''} LIMIT 1`,
        args: [agentId],
    })
    const receipt = result.rows[0]
    if (!receipt && internalCreationRequestId === undefined) return null
    if (receipt && internalCreationRequestId !== undefined && receipt.request_id === internalCreationRequestId &&
        (receipt.phase === 'created' || receipt.phase === 'started')) {
        let intent: unknown
        try { intent = JSON.parse(String(receipt.intent)) } catch { /* Refuse a damaged recovery receipt. */ }
        const text = intent && typeof intent === 'object' && 'kickoff' in intent ? intent.kickoff : null
        if (typeof text === 'string' && text.length > 0 && text.length <= 2000) return {requestId: internalCreationRequestId, text}
    }
    throw new DesktopHttpError(409, desktopCreationPendingMessage)
}

/** A lost final response must still be able to present and acknowledge its exact coworker. */
export async function assertDesktopCreationAcknowledged(db: Client, agentId: string): Promise<void> {
    const pending = await db.execute({sql: 'SELECT 1 FROM desktop_creations WHERE agent_id=? AND acknowledged=0 LIMIT 1', args: [agentId]})
    if (pending.rows.length) throw new DesktopHttpError(409, desktopCreationPendingMessage)
}
