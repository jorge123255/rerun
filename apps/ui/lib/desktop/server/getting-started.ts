import 'server-only'
import type { Client } from '@libsql/client'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { z } from 'zod'
import { listConnections, request as engineRequest } from '@/lib/engine/client'
import { desktopGettingStartedResponse, type DesktopGettingStartedFacts, type DesktopGettingStartedResponse } from '../getting-started/progress'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { withRosterWrite } from './roster-writes'
import { assertDesktopWorkspaceAdmission } from './workspace-admission'

export const DESKTOP_GETTING_STARTED_SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_getting_started (
    workspace_id INTEGER PRIMARY KEY CHECK (workspace_id >= 1),
    dismissed INTEGER NOT NULL CHECK (dismissed IN (0, 1)),
    updated_at TEXT NOT NULL
);`

const COWORKERS_SQL = `SELECT a.id, a.engine_agent_id
FROM desktop_agents a
WHERE a.workspace_id = ?
  AND a.engine_agent_id <> ?
  AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id)`

const MODEL_CHATS_SQL = `SELECT COUNT(*) AS model_chats
FROM desktop_sessions s
JOIN desktop_agents a ON a.id = s.agent_id
WHERE a.workspace_id = ?
  AND a.engine_agent_id <> ?
  AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id)
  AND s.model_connection_id IS NOT NULL AND length(trim(s.model_connection_id)) > 0
  AND s.model IS NOT NULL AND length(trim(s.model)) > 0`

const scheduleListSchema = z.object({ schedules: z.array(z.object({ slug: z.string() }).passthrough()) })

function workspaceIdOf(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new DesktopHttpError(409, 'Desktop workspace is unavailable')
    return value
}

export async function ensureDesktopGettingStartedSchema(db: Pick<Client, 'executeMultiple'>): Promise<void> {
    await db.executeMultiple(DESKTOP_GETTING_STARTED_SCHEMA)
}

async function dismissed(db: Pick<Client, 'execute'>, workspaceId: number): Promise<boolean> {
    const rows = await db.execute({ sql: 'SELECT dismissed FROM desktop_getting_started WHERE workspace_id = ?', args: [workspaceId] })
    return Number(rows.rows[0]?.dismissed) === 1
}

export async function readDesktopGettingStartedFacts(db: Pick<Client, 'execute'>, workspaceId: number, extras: { schedules: number | null; connectedProviders: number | null }): Promise<DesktopGettingStartedFacts> {
    const id = workspaceIdOf(workspaceId)
    const [coworkers, models] = await Promise.all([
        db.execute({ sql: COWORKERS_SQL, args: [id, FOREMAN_AGENT_ID] }),
        db.execute({ sql: MODEL_CHATS_SQL, args: [id, FOREMAN_AGENT_ID] }),
    ])
    return {
        coworkers: coworkers.rows.length,
        modelChats: Number(models.rows[0]?.model_chats ?? 0),
        connectedProviders: extras.connectedProviders,
        schedules: extras.schedules,
    }
}

/** Local engine routine list. A failed read stays null so the step is not marked done or empty. */
export async function countDesktopGettingStartedSchedules(runtime: DesktopRuntime, engineAgentIds: readonly string[], signal?: AbortSignal): Promise<number | null> {
    if (engineAgentIds.length === 0) return 0
    const engine = engineOf(runtime)
    let count = 0
    for (const engineAgentId of engineAgentIds) {
        if (engineAgentId === FOREMAN_AGENT_ID) continue
        try {
            const schedules = await engineRequest(engine, `/desktop/workspace-routines/${encodeURIComponent(engineAgentId)}`, { method: 'GET', signal, cache: 'no-store' }, value => scheduleListSchema.parse(value).schedules)
            signal?.throwIfAborted()
            count += schedules.length
        } catch {
            return null
        }
    }
    return count
}

export async function countDesktopGettingStartedProviders(runtime: DesktopRuntime, signal?: AbortSignal): Promise<number | null> {
    try {
        const list = await listConnections(engineOf(runtime), { cache: 'no-store', signal })
        signal?.throwIfAborted()
        return list.connections.filter(connection => connection.connected && !connection.credentialRejected).length
    } catch {
        return null
    }
}

async function factsFor(runtime: DesktopRuntime, db: Client, signal?: AbortSignal): Promise<DesktopGettingStartedFacts> {
    // Each active workspace has its own database. Its roster is stored under local row 1.
    const localWorkspaceId = 1
    const coworkers = await db.execute({ sql: COWORKERS_SQL, args: [localWorkspaceId, FOREMAN_AGENT_ID] })
    return readDesktopGettingStartedFacts(db, localWorkspaceId, {
        schedules: await countDesktopGettingStartedSchedules(runtime, coworkers.rows.map(row => String(row.engine_agent_id)), signal),
        connectedProviders: await countDesktopGettingStartedProviders(runtime, signal),
    })
}

export async function readDesktopGettingStarted(runtime: DesktopRuntime, signal?: AbortSignal): Promise<DesktopGettingStartedResponse> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensureDesktopGettingStartedSchema(db)
    const workspaceId = workspaceIdOf(runtime.workspaceId)
    return desktopGettingStartedResponse(workspaceId, await dismissed(db, workspaceId), await factsFor(runtime, db, signal))
}

export async function setDesktopGettingStartedDismissed(runtime: DesktopRuntime, dismissedFlag: boolean): Promise<DesktopGettingStartedResponse> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensureDesktopGettingStartedSchema(db)
    const workspaceId = workspaceIdOf(runtime.workspaceId)
    await withRosterWrite(async () => {
        assertDesktopWorkspaceAdmission(runtime)
        await db.execute({
            sql: `INSERT INTO desktop_getting_started (workspace_id, dismissed, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(workspace_id) DO UPDATE SET dismissed = excluded.dismissed, updated_at = excluded.updated_at`,
            args: [workspaceId, dismissedFlag ? 1 : 0, new Date().toISOString()],
        })
    })
    const saved = await dismissed(db, workspaceId)
    const facts = await factsFor(runtime, db)
    if (saved !== dismissedFlag) throw new DesktopHttpError(409, 'Getting started could not be saved for this workspace')
    return desktopGettingStartedResponse(workspaceId, saved, facts)
}

export { COWORKERS_SQL, MODEL_CHATS_SQL }
