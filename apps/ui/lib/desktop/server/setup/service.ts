import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DESKTOP_SETUP_DEFAULT_PROMPT, type DesktopSetupMutationResult, type DesktopSetupView } from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import type { Client } from '@libsql/client'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent, createDesktopSession, type DesktopAgent } from '../store'

const engineSetupSchema = z.object({
    required: z.boolean().nullable(),
    prompt: z.string(),
    completedAt: z.string().nullable(),
    sessionId: z.string().nullable(),
    pending: z.boolean(),
    revision: z.string(),
})
type EngineSetup = z.infer<typeof engineSetupSchema>

async function ensureSetupTables(db: Client) {
    await db.batch([
        { sql: `CREATE TABLE IF NOT EXISTS desktop_setup_state (
            agent_id TEXT PRIMARY KEY REFERENCES desktop_agents(id) ON DELETE CASCADE,
            skipped INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )`, args: [] },
        { sql: `CREATE TABLE IF NOT EXISTS desktop_setup_mutations (
            request_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            action TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at TEXT NOT NULL
        )`, args: [] },
        { sql: `CREATE TABLE IF NOT EXISTS desktop_setup_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            detail TEXT,
            created_at TEXT NOT NULL
        )`, args: [] },
    ])
}

async function skippedOf(db: Client, agentId: string): Promise<boolean> {
    const result = await db.execute({ sql: 'SELECT skipped FROM desktop_setup_state WHERE agent_id = ?', args: [agentId] })
    return Number(result.rows[0]?.skipped) === 1
}

async function setSkipped(db: Client, agentId: string, skipped: boolean) {
    await db.execute({
        sql: `INSERT INTO desktop_setup_state (agent_id, skipped, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(agent_id) DO UPDATE SET skipped = excluded.skipped, updated_at = excluded.updated_at`,
        args: [agentId, Number(skipped), new Date().toISOString()],
    })
}

async function recordEvent(db: Client, agentId: string, kind: string, detail?: string) {
    await db.execute({ sql: 'INSERT INTO desktop_setup_events (agent_id, kind, detail, created_at) VALUES (?, ?, ?, ?)', args: [agentId, kind, detail ?? null, new Date().toISOString()] })
}

async function engineSetup(runtime: DesktopRuntime, engineAgentId: string): Promise<EngineSetup> {
    return request({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }, `/agents/${encodeURIComponent(engineAgentId)}/setup`, { method: 'GET' }, d => engineSetupSchema.parse(d))
}

async function viewOf(db: Client, agent: DesktopAgent, setup: EngineSetup, skipped: boolean): Promise<DesktopSetupView> {
    const revision = createHash('sha256').update(`${setup.revision}:${skipped ? 1 : 0}`).digest('base64url').slice(0, 24)
    let sessionId: string | null = null
    if (setup.sessionId) {
        sessionId = await ensureSetupDesktopSession(db, agent, setup.sessionId)
    }
    return {
        agentId: agent.id,
        revision,
        required: setup.required,
        prompt: setup.prompt,
        completedAt: setup.completedAt,
        sessionId,
        pending: setup.pending && !skipped,
        skipped,
        defaultPrompt: DESKTOP_SETUP_DEFAULT_PROMPT,
    }
}

async function agentFor(runtime: DesktopRuntime, agentId: string): Promise<{ db: Client; agent: DesktopAgent }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensureSetupTables(db)
    const agent = await findDesktopAgent(db, agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { db, agent }
}

export async function readDesktopSetupView(runtime: DesktopRuntime, agentId: string): Promise<DesktopSetupView> {
    const { db, agent } = await agentFor(runtime, agentId)
    const setup = await engineSetup(runtime, agent.engineAgentId)
    if (setup.completedAt && !(await db.execute({ sql: "SELECT 1 FROM desktop_setup_events WHERE agent_id = ? AND kind = 'completed'", args: [agentId] })).rows.length) {
        await recordEvent(db, agentId, 'completed')
    }
    return viewOf(db, agent, setup, await skippedOf(db, agentId))
}

async function ensureSetupDesktopSession(db: Client, agent: DesktopAgent, engineSessionId: string) {
    const existing = await db.execute({ sql: 'SELECT id FROM desktop_sessions WHERE agent_id = ? AND engine_session_id = ?', args: [agent.id, engineSessionId] })
    if (existing.rows[0]) return String(existing.rows[0].id)
    const session = await createDesktopSession(db, { agentId: agent.id, engineSessionId, title: 'Setup' })
    return session.id
}

async function applyMutation(runtime: DesktopRuntime, agentId: string, action: string, requestId: string, expectedRevision: string, body?: { prompt: string; required: boolean | null }): Promise<DesktopSetupMutationResult> {
    const { db, agent } = await agentFor(runtime, agentId)
    const prior = await db.execute({ sql: 'SELECT result FROM desktop_setup_mutations WHERE request_id = ?', args: [requestId] })
    if (prior.rows[0]) return JSON.parse(String(prior.rows[0].result)) as DesktopSetupMutationResult

    const current = await viewOf(db, agent, await engineSetup(runtime, agent.engineAgentId), await skippedOf(db, agentId))
    if (current.revision !== expectedRevision) throw new DesktopHttpError(409, 'The setup changed since it was read. Reload and try again.')

    const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
    const base = `/agents/${encodeURIComponent(agent.engineAgentId)}/setup`
    let sessionId: string | null | undefined
    switch (action) {
        case 'save': {
            await request(conn, `${base}/save`, { method: 'POST', body: JSON.stringify({ prompt: body?.prompt ?? '', required: body?.required ?? null }) })
            await recordEvent(db, agentId, 'saved')
            break
        }
        case 'start':
        case 'continue': {
            await setSkipped(db, agentId, false)
            const claimed = action === 'start'
                ? await request(conn, `${base}/claim`, { method: 'POST', body: '{}' }).then(d => d as { sessionId?: string }).catch(err => {
                    if (err instanceof Error && 'status' in err && (err as { status: number }).status === 409) return null
                    throw err
                })
                : await request(conn, `${base}/continue`, { method: 'POST', body: '{}' }).then(d => d as { sessionId: string })
            const engineSessionId = claimed && claimed.sessionId ? claimed.sessionId : null
            if (engineSessionId === null && action === 'start') {
                const again = await engineSetup(runtime, agent.engineAgentId)
                if (!again.sessionId) throw new DesktopHttpError(409, 'The setup chat could not be claimed. Try again.')
                sessionId = await ensureSetupDesktopSession(db, agent, again.sessionId)
            } else if (engineSessionId) {
                sessionId = await ensureSetupDesktopSession(db, agent, engineSessionId)
            }
            await recordEvent(db, agentId, action === 'start' ? 'started' : 'continued', engineSessionId ?? undefined)
            break
        }
        case 'skip': {
            await setSkipped(db, agentId, true)
            await recordEvent(db, agentId, 'skipped')
            break
        }
        default:
            throw new DesktopHttpError(400, 'Unknown setup action')
    }

    const view = await readDesktopSetupView(runtime, agentId)
    const result: DesktopSetupMutationResult = { view, ...(sessionId ? { sessionId } : {}) }
    await db.execute({ sql: 'INSERT INTO desktop_setup_mutations (request_id, agent_id, action, result, created_at) VALUES (?, ?, ?, ?, ?)', args: [requestId, agentId, action, JSON.stringify(result), new Date().toISOString()] })
    return result
}

export function mutateDesktopSetup(runtime: DesktopRuntime, agentId: string, input: { action: string; requestId: string; expectedRevision: string; prompt?: string; required?: boolean | null }): Promise<DesktopSetupMutationResult> {
    return applyMutation(runtime, agentId, input.action, input.requestId, input.expectedRevision, input.action === 'save' ? { prompt: input.prompt ?? '', required: input.required ?? null } : undefined)
}
