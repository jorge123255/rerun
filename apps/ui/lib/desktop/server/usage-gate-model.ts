import 'server-only'
import { desktopBackupNote, desktopBackupPick, desktopPlanExhausted, desktopPlanOutMessage, desktopPlanWait, desktopPresetTier, isDesktopPlanProvider, resolveDesktopPreset, type ConnectionSummary, type DesktopBackupModel, type DesktopPresetTier } from '@rerun/contracts'
import { desktopConnectionModelLabel, desktopConnections } from '../chat-model'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'

/**
 * The model side of the usage gate: the owner's backup model, and the decision made just before a
 * message or a routine starts on a plan that is out of usage.
 */
export const DESKTOP_PLAN_OUT_CODE = 'plan_out_of_usage'

export type DesktopPlanOut = { connectionId: string; name: string; provider: string }

/** A send refused before it starts because its plan is out. Carries what the chat needs to offer waiting. */
export class DesktopPlanOutHttpError extends DesktopHttpError {
    constructor(readonly plan: DesktopPlanOut, readonly resetsAt: string | null) {
        super(409, desktopPlanOutMessage(plan.name, resetsAt), DESKTOP_PLAN_OUT_CODE)
    }
}

export async function readDesktopBackupModel(runtime: DesktopRuntime): Promise<DesktopBackupModel | null> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const row = (await db.execute('SELECT connection_id,model FROM desktop_usage_backup_model WHERE id = 1')).rows[0]
    return row ? { connectionId: String(row.connection_id), model: String(row.model) } : null
}

export type DesktopBackupModelView = { backup: DesktopBackupModel | null; options: { connectionId: string; name: string; plan: boolean; models: { id: string; label: string }[] }[] }

/**
 * What Settings shows: the saved backup, and every model that could be picked, each marked as a
 * monthly plan or not, so a choice to pay per token is made knowingly.
 */
export async function readDesktopBackupModelView(runtime: DesktopRuntime, connections: ConnectionSummary[]): Promise<DesktopBackupModelView> {
    return {
        backup: await readDesktopBackupModel(runtime),
        options: desktopConnections(connections).filter(connection => connection.connected).map(connection => ({
            connectionId: connection.id, name: connection.name, plan: isDesktopPlanProvider(connection.provider),
            models: [...connection.models, ...connection.extraModels].map(model => ({ id: model, label: desktopConnectionModelLabel(connection, model) })),
        })),
    }
}

/** Saves exactly the pair the owner picked. A preset is not a model, and an unknown pair is refused. */
export async function saveDesktopBackupModel(runtime: DesktopRuntime, connections: ConnectionSummary[], pick: DesktopBackupModel | null): Promise<void> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    if (!pick) { await db.execute('DELETE FROM desktop_usage_backup_model WHERE id = 1'); return }
    const connection = desktopConnections(connections).find(item => item.id === pick.connectionId)
    if (desktopPresetTier(pick) || !connection?.connected || ![...connection.models, ...connection.extraModels].includes(pick.model))
        throw new DesktopHttpError(400, 'Choose a model offered by a connected provider.')
    await db.execute({ sql: 'INSERT INTO desktop_usage_backup_model(id,connection_id,model) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id,model=excluded.model', args: [pick.connectionId, pick.model] })
}

/** The first plan a preset passed over for being out of usage, when that is why it has nothing to run on. */
export function desktopPlanOutOfPreset(tier: DesktopPresetTier, connections: ConnectionSummary[], now: Date = new Date()): ConnectionSummary | null {
    if (resolveDesktopPreset(tier, connections, now)) return null
    return connections.find(item => isDesktopPlanProvider(item.provider) && item.connected && !item.credentialRejected && desktopPlanExhausted(item.planLimits, now)) ?? null
}

export type DesktopUsageGated = { connectionId: string; model: string; note?: string }

/** The backup that may answer for this plan now, with the line that tells the person so. */
export function desktopBackupFor(connections: ConnectionSummary[], backup: DesktopBackupModel | null, out: Pick<ConnectionSummary, 'id' | 'name'>, now: Date = new Date()): Required<DesktopUsageGated> | null {
    const found = desktopBackupPick(backup, connections, out.id, now)
    if (!found) return null
    const label = desktopConnectionModelLabel(connections.find(item => item.id === found.connectionId), found.model)
    return { connectionId: found.connectionId, model: found.model, note: desktopBackupNote(found.name, label, out.name) }
}

/**
 * The pick as it may start now. A plan with a full window whose reset is still ahead (or `out`,
 * when the caller already knows it is out) gives way to the backup, and without one the send is
 * refused. A key billed per token is never chosen here: only the saved backup is.
 */
export function gateDesktopPick(connections: ConnectionSummary[], pick: { connectionId: string; model: string }, backup: DesktopBackupModel | null, now: Date = new Date(), out = false): DesktopUsageGated {
    const connection = connections.find(item => item.id === pick.connectionId)
    if (!connection || !isDesktopPlanProvider(connection.provider)) return pick
    const reading = desktopPlanWait(connection.planLimits, now)
    if (!out && reading.state !== 'waiting') return pick
    const found = desktopBackupFor(connections, backup, connection, now)
    if (found) return found
    throw new DesktopPlanOutHttpError({ connectionId: connection.id, name: connection.name, provider: connection.provider }, reading.resetsAt)
}
