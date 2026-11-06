import 'server-only'
import { z } from 'zod'
import { desktopRerunGrantsOf } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { getAgent } from '@/lib/engine/client'
import { findDesktopAgent } from '../store'
import { assertDesktopSetupChatAllowed } from '../setup/service'
import { resolveDesktopChatModel } from '../chat-model'
import { desktopTriggersApi, type DesktopTriggerDurableStore } from './api'
import { adoptDesktopTriggerSession } from './adoption'

export type AuthorizeDesktopTrigger = (runtime: DesktopRuntime, db: Client, engineAgentId: string, signal?: AbortSignal) => Promise<void>
export type DesktopTriggerManagementConfig = { durable: DesktopTriggerDurableStore; authorize?: AuthorizeDesktopTrigger }
/** Kept for old source callers; production routes now use one engine lifecycle over the authenticated bridge. */
export function configureDesktopTriggersManagement(config: DesktopTriggerManagementConfig | null): void { if (config) throw new Error('Trigger management now requires the authenticated engine lifecycle route') }
export function getDesktopTriggersManagementConfig(): DesktopTriggerManagementConfig | null { return null }
async function owner(runtime: DesktopRuntime, db: Client, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const result = await db.execute({ sql: 'SELECT a.id,a.enabled,d.agent_id AS deleting FROM desktop_agents a LEFT JOIN desktop_deletions d ON d.agent_id=a.id WHERE a.workspace_id=1 AND a.engine_agent_id=?', args: [id] })
    if (result.rows.length !== 1 || result.rows[0].deleting != null) throw new DesktopHttpError(404, 'Coworker not found')
    const row = result.rows[0], detail = await getAgent(engineOf(runtime), id)
    if (detail.id !== id) throw new DesktopHttpError(409, 'Coworker identity changed')
    const current = await findDesktopAgent(db, String(row.id))
    if (!current || current.engineAgentId !== id) throw new DesktopHttpError(409, 'Coworker identity changed')
    const deleting = (await db.execute({ sql: 'SELECT 1 FROM desktop_deletions WHERE agent_id=?', args: [current.id] })).rows.length > 0
    signal?.throwIfAborted()
    if (deleting) throw new DesktopHttpError(409, 'Coworker is being deleted')
    return { agent: current, detail, identity: { localAgentId: current.id, engineAgentId: id, enabled: current.enabled && detail.config.enabled, deleting: false } }
}
export async function authorizeDesktopTriggersBasic(runtime: DesktopRuntime, db: Client, id: string, signal?: AbortSignal) { await owner(runtime, db, id, signal) }
async function enabledOwner(runtime: DesktopRuntime, db: Client, id: string, signal?: AbortSignal) {
    const result = await owner(runtime, db, id, signal)
    if (!result.identity.enabled) throw new DesktopHttpError(403, 'Enable this coworker to run triggers')
    return result
}
export async function authorizeDesktopTriggers(runtime: DesktopRuntime, db: Client, id: string, signal?: AbortSignal) {
    const result = await enabledOwner(runtime, db, id, signal)
    if (!(desktopRerunGrantsOf(result.detail.config.tools) as Record<string, boolean>).trigger) throw new DesktopHttpError(403, 'Enable Triggers in this coworker’s Tools')
    return result
    return result
}
const identity = z.string().min(1).max(200)
const envelope = z.strictObject({ event: z.literal('desktop.trigger'), launchNonce: identity, op: z.enum(['owner', 'authorize', 'setup', 'model', 'adopt']), payload: z.unknown() })
const ownerInput = z.strictObject({ engineAgentId: identity })
export async function handleDesktopTriggerBridge(runtime: DesktopRuntime, body: unknown, signal?: AbortSignal): Promise<Response | null> {
    if (!body || typeof body !== 'object' || !('event' in body) || body.event !== 'desktop.trigger') return null
    const event = envelope.parse(body)
    if (event.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Trigger launch changed')
    const db = await openDesktopDatabase(runtime.dataRoot)
    let result: unknown
    if (event.op === 'adopt') {
        const input = z.strictObject({ localAgentId: identity, engineAgentId: identity, engineSessionId: identity, runId: identity.nullable(), title: z.string().max(160) }).parse(event.payload)
        const current = await owner(runtime, db, input.engineAgentId, signal)
        if (current.agent.id !== input.localAgentId) throw new DesktopHttpError(409, 'Coworker identity changed')
        result = await adoptDesktopTriggerSession(db, engineOf(runtime), { agentId: input.localAgentId, engineAgentId: input.engineAgentId, engineSessionId: input.engineSessionId, runId: input.runId }, { signal })
    } else if (event.op === 'model') {
        const input = z.strictObject({ engineAgentId: identity, override: z.strictObject({ connectionId: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable() }) }).parse(event.payload)
        const current = await enabledOwner(runtime, db, input.engineAgentId, signal)
        await assertDesktopSetupChatAllowed(runtime, current.agent.id)
        if ((input.override.connectionId === null) !== (input.override.model === null) || (input.override.provider !== null && input.override.connectionId === null)) throw new DesktopHttpError(409, 'Choose a currently connected trigger model')
        const selected = await resolveDesktopChatModel(runtime, current.agent, null, input.override.connectionId && input.override.model ? { connectionId: input.override.connectionId, model: input.override.model } : undefined)
        const confirmed = await enabledOwner(runtime, db, input.engineAgentId, signal)
        if (confirmed.agent.id !== current.agent.id) throw new DesktopHttpError(409, 'Coworker identity changed')
        await assertDesktopSetupChatAllowed(runtime, confirmed.agent.id)
        result = { connectionId: selected.connectionId, model: selected.model }
    } else {
        const input = ownerInput.parse(event.payload)
        const current = event.op === 'owner'
            ? await owner(runtime, db, input.engineAgentId, signal)
            : event.op === 'authorize'
                ? await authorizeDesktopTriggers(runtime, db, input.engineAgentId, signal)
                : await enabledOwner(runtime, db, input.engineAgentId, signal)
        if (event.op === 'setup') await assertDesktopSetupChatAllowed(runtime, current.agent.id)
        result = current.identity
    }
    return Response.json({ ok: true, result }, { headers: { 'Cache-Control': 'no-store' } })
}
export async function desktopTriggerRequest(runtime: DesktopRuntime, request: Request, agentId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    return desktopTriggersApi(db, id => authorizeDesktopTriggersBasic(runtime, db, id, request.signal))(request, agentId)
}
