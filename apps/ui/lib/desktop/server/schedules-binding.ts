import 'server-only'
import { desktopRerunGrantsOf } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { getAgent } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { withRosterWrite } from './roster-writes'
import { desktopSchedulesApi } from './schedules/api'
import { adoptDesktopScheduleEvent } from './schedules/adoption'

const identity = z.string().min(1).max(200)
const bridgeSchema = z.discriminatedUnion('event', [
    z.object({ event: z.literal('desktop.schedule.authorize'), agentId: identity }).strict(),
    z.object({ event: z.literal('desktop.schedule.adopt'), agentId: identity, sessionId: identity, runId: identity.nullable(), title: z.string().max(160) }).strict(),
    z.object({ event: z.literal('desktop.schedule.shutdown') }).strict(),
])
// Next can load the callback and browser routes in different bundles in the same UI process.
const closedKey = Symbol.for('rerun.desktop.schedule.closed.v1')
const globalState = globalThis as typeof globalThis & { [closedKey]?: Set<string> }
const closed = globalState[closedKey] ??= new Set<string>()
const keyOf = (runtime: DesktopRuntime) => `${runtime.dataRoot}\0${runtime.launchNonce}`
function assertActive(runtime: DesktopRuntime, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (closed.has(keyOf(runtime))) throw new DesktopHttpError(503, 'Routines are stopping. Reopen Rerun to continue.')
}

async function localOwner(db: Client, engineAgentId: string) {
    const result = await db.execute({ sql: `SELECT a.id,a.enabled,d.agent_id AS deleting FROM desktop_agents a
        LEFT JOIN desktop_deletions d ON d.agent_id=a.id WHERE a.workspace_id=1 AND a.engine_agent_id=?`, args: [engineAgentId] })
    const owner = result.rows[0]
    if (result.rows.length !== 1 || !owner) throw new DesktopHttpError(404, 'Coworker not found')
    if (owner.deleting !== null && owner.deleting !== undefined) throw new DesktopHttpError(409, 'This coworker is being deleted')
    if (Number(owner.enabled) !== 1) throw new DesktopHttpError(403, 'Enable this coworker to use routines')
    return String(owner.id)
}

/** Current local and engine ownership/grant on every admission, including each launch checkpoint. */
export async function authorizeDesktopSchedules(runtime: DesktopRuntime, db: Client, engineAgentId: string, signal?: AbortSignal): Promise<void> {
    assertActive(runtime, signal)
    const owner = await withRosterWrite(() => localOwner(db, engineAgentId))
    assertActive(runtime, signal)
    const current = await getAgent(engineOf(runtime), engineAgentId)
    assertActive(runtime, signal)
    if (current.id !== engineAgentId || !current.config.enabled) throw new DesktopHttpError(409, 'Coworker identity or enabled state changed')
    if (!desktopRerunGrantsOf(current.config.tools).schedule) throw new DesktopHttpError(403, 'Enable Schedules in this coworker’s Capabilities to use routines')
    await withRosterWrite(async () => {
        assertActive(runtime, signal)
        if (await localOwner(db, engineAgentId) !== owner) throw new DesktopHttpError(409, 'Coworker identity changed')
        assertActive(runtime, signal)
    })
}

/** Caller MUST authenticate the engine callback before dispatching this function. */
export async function handleDesktopScheduleBridge(runtime: DesktopRuntime, body: unknown, signal?: AbortSignal): Promise<Response | null> {
    if (!body || typeof body !== 'object' || !('event' in body) || typeof body.event !== 'string' || !body.event.startsWith('desktop.schedule.')) return null
    const parsed = bridgeSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid scheduled task callback')
    const event = parsed.data
    if (event.event === 'desktop.schedule.shutdown') {
        closed.add(keyOf(runtime))
        return Response.json({ ok: true, persisted: true }, { headers: { 'Cache-Control': 'no-store' } })
    }
    assertActive(runtime, signal)
    const db = await openDesktopDatabase(runtime.dataRoot)
    await authorizeDesktopSchedules(runtime, db, event.agentId, signal)
    if (event.event === 'desktop.schedule.adopt') {
        // The adopter fetches the actual session/title and verifies exact owner/source/run.
        const adopted = await adoptDesktopScheduleEvent(db, engineOf(runtime), event)
        if (!adopted) throw new DesktopHttpError(409, 'Scheduled conversation could not be saved')
        await authorizeDesktopSchedules(runtime, db, event.agentId, signal)
    }
    assertActive(runtime, signal)
    return Response.json({ ok: true, persisted: true }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function desktopScheduleRequest(runtime: DesktopRuntime, request: Request, agentId: string) {
    assertActive(runtime, request.signal)
    const db = await openDesktopDatabase(runtime.dataRoot)
    return desktopSchedulesApi(db, id => authorizeDesktopSchedules(runtime, db, id, request.signal))(request, agentId)
}
