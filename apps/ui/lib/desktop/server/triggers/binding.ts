import 'server-only'
import { z } from 'zod'
import type { Client } from '@libsql/client'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { withRosterWrite } from '../roster-writes'
import { getAgent } from '@/lib/engine/client'
import { desktopTriggersApi, type DesktopTriggerDurableStore } from './api'
import { adoptDesktopTriggerEvent } from './adoption'

const identity = z.string().min(1).max(200)
const bridgeSchema = z.discriminatedUnion('event', [
    z.object({ event: z.literal('desktop.trigger.authorize'), agentId: identity }).strict(),
    z.object({ event: z.literal('desktop.trigger.adopt'), agentId: identity, sessionId: identity, runId: identity.nullable(), title: z.string().max(160) }).strict(),
    z.object({ event: z.literal('desktop.trigger.shutdown') }).strict(),
    z.object({ event: z.literal('desktop.trigger.revoke'), agentId: identity }).strict(),
])

const closedKey = Symbol.for('rerun.desktop.trigger.closed.v1')
const revokedKey = Symbol.for('rerun.desktop.trigger.revoked.v1')
const configKey = Symbol.for('rerun.desktop.trigger.management.v1')
const globalState = globalThis as typeof globalThis & {
    [closedKey]?: Set<string>
    [revokedKey]?: Set<string>
    [configKey]?: DesktopTriggerManagementConfig | null
}
const closed = globalState[closedKey] ??= new Set<string>()
const revoked = globalState[revokedKey] ??= new Set<string>()
const keyOf = (runtime: DesktopRuntime) => `${runtime.dataRoot}\0${runtime.launchNonce}`

export type AuthorizeDesktopTrigger = (runtime: DesktopRuntime, db: Client, engineAgentId: string, signal?: AbortSignal) => Promise<void>

export type DesktopTriggerManagementConfig = {
    /** REQUIRED durable revision/mutation/event store from bindDesktopTriggers (or equivalent). */
    durable: DesktopTriggerDurableStore
    authorize?: AuthorizeDesktopTrigger
}

function assertActive(runtime: DesktopRuntime, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (closed.has(keyOf(runtime))) throw new DesktopHttpError(503, 'Triggers are stopping. Reopen Rerun to continue.')
}

async function localOwner(db: Client, engineAgentId: string) {
    const result = await db.execute({
        sql: `SELECT a.id,a.enabled,d.agent_id AS deleting FROM desktop_agents a
        LEFT JOIN desktop_deletions d ON d.agent_id=a.id WHERE a.workspace_id=1 AND a.engine_agent_id=?`,
        args: [engineAgentId],
    })
    const owner = result.rows[0]
    if (result.rows.length !== 1 || !owner) throw new DesktopHttpError(404, 'Coworker not found')
    if (owner.deleting !== null && owner.deleting !== undefined) throw new DesktopHttpError(409, 'This coworker is being deleted')
    if (Number(owner.enabled) !== 1) throw new DesktopHttpError(403, 'Enable this coworker to use triggers')
    if (revoked.has(engineAgentId)) throw new DesktopHttpError(404, 'Coworker triggers revoked')
    return String(owner.id)
}

/**
 * Root MUST call this once with the durable engine store before management admits work.
 * Omitting durable (or passing a memory stub) is a configuration error — requests fail closed.
 */
export function configureDesktopTriggersManagement(config: DesktopTriggerManagementConfig | null): void {
    if (config && (!config.durable || typeof config.durable.listEvents !== 'function')) {
        throw new Error('configureDesktopTriggersManagement requires a durable store with listEvents/getRevision/bumpRevision/findMutation/rememberMutation')
    }
    globalState[configKey] = config
}

export function getDesktopTriggersManagementConfig(): DesktopTriggerManagementConfig | null {
    return globalState[configKey] ?? null
}

export async function authorizeDesktopTriggersBasic(runtime: DesktopRuntime, db: Client, engineAgentId: string, signal?: AbortSignal): Promise<void> {
    assertActive(runtime, signal)
    const owner = await withRosterWrite(() => localOwner(db, engineAgentId))
    assertActive(runtime, signal)
    const current = await getAgent(engineOf(runtime), engineAgentId)
    assertActive(runtime, signal)
    if (current.id !== engineAgentId || !current.config.enabled) throw new DesktopHttpError(409, 'Coworker identity or enabled state changed')
    // Does NOT invent an allow-all grant. Root should replace with grant-aware authorize.
    await withRosterWrite(async () => {
        assertActive(runtime, signal)
        if (await localOwner(db, engineAgentId) !== owner) throw new DesktopHttpError(409, 'Coworker identity changed')
        assertActive(runtime, signal)
    })
}

/** Caller MUST authenticate the engine callback before dispatching. */
export async function handleDesktopTriggerBridge(runtime: DesktopRuntime, body: unknown, signal?: AbortSignal): Promise<Response | null> {
    if (!body || typeof body !== 'object' || !('event' in body) || typeof body.event !== 'string' || !body.event.startsWith('desktop.trigger.')) return null
    const parsed = bridgeSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid trigger callback')
    const event = parsed.data
    if (event.event === 'desktop.trigger.shutdown') {
        closed.add(keyOf(runtime))
        return Response.json({ ok: true, persisted: true }, { headers: { 'Cache-Control': 'no-store' } })
    }
    assertActive(runtime, signal)
    const db = await openDesktopDatabase(runtime.dataRoot)
    if (event.event === 'desktop.trigger.revoke') {
        revoked.add(event.agentId)
        return Response.json({ ok: true, persisted: true }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const authorize = getDesktopTriggersManagementConfig()?.authorize ?? authorizeDesktopTriggersBasic
    await authorize(runtime, db, event.agentId, signal)
    if (event.event === 'desktop.trigger.adopt') {
        const adopted = await adoptDesktopTriggerEvent(db, engineOf(runtime), event)
        if (!adopted) throw new DesktopHttpError(409, 'Trigger conversation could not be saved')
        await authorize(runtime, db, event.agentId, signal)
    }
    assertActive(runtime, signal)
    return Response.json({ ok: true, persisted: true }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function desktopTriggerRequest(runtime: DesktopRuntime, request: Request, agentId: string) {
    assertActive(runtime, request.signal)
    const config = getDesktopTriggersManagementConfig()
    if (!config?.durable) {
        throw new DesktopHttpError(503, 'Trigger durable store is not configured. Root must call configureDesktopTriggersManagement before admitting management.')
    }
    const db = await openDesktopDatabase(runtime.dataRoot)
    const authorize = config.authorize ?? authorizeDesktopTriggersBasic
    return desktopTriggersApi(db, id => authorize(runtime, db, id, request.signal), config.durable)(request, agentId)
}
