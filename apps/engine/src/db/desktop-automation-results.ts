import type { Client } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { desktopAutomationResultSchema, type DesktopAutomationResult } from '@rerun/contracts'
import { ensureRunCompletions } from './completed-runs.js'
import { getSystemDb } from './systemDb.js'
import { sessions } from './schema.js'

type Automation = { agentId: string; sessionId: string; runId: string; source: 'schedule' | 'trigger' }

const initialized = new WeakMap<Client, Promise<void>>()
export function ensureDesktopAutomationResults(client: Client): Promise<void> {
    let ready = initialized.get(client)
    if (!ready) {
        ready = client.execute(`CREATE TABLE IF NOT EXISTS desktop_automation_results (
            agent_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
            result_json TEXT NOT NULL, PRIMARY KEY (agent_id, session_id)
        )`).then(() => undefined).catch(error => { initialized.delete(client); throw error })
        initialized.set(client, ready)
    }
    return ready
}

// A done run row can also mean a turn ended on a question or approval. The matching completion
// receipt is written only on a successful terminal, after the actual report has been persisted.
const eligible = `FROM run_completions c
    JOIN runs r ON r.id = c.run_id AND r.agent_id = c.agent_id AND r.session_id = c.session_id AND r.status = 'done'
    JOIN sessions s ON s.id = c.session_id AND s.agent_id = c.agent_id AND s.source = c.source
    WHERE c.agent_id = ? AND c.session_id = ? AND c.run_id = ? AND c.source = ?
      AND NOT EXISTS (SELECT 1 FROM desktop_automation_results a WHERE a.agent_id = c.agent_id AND a.session_id = c.session_id)`

export async function readUnlabelledAutomationReport(input: Automation): Promise<string | null> {
    const { client } = await getSystemDb(input.agentId)
    await ensureDesktopAutomationResults(client)
    await ensureRunCompletions(client)
    const { rows: [row] } = await client.execute({
        sql: `SELECT c.text ${eligible}`, args: [input.agentId, input.sessionId, input.runId, input.source],
    })
    return typeof row?.text === 'string' ? row.text.trim().slice(0, 2000) || null : null
}

export async function recordDesktopAutomationResult(input: Automation, result: DesktopAutomationResult, signal: AbortSignal): Promise<void> {
    const { client } = await getSystemDb(input.agentId)
    await ensureDesktopAutomationResults(client)
    await ensureRunCompletions(client)
    signal.throwIfAborted()
    await client.execute({
        sql: `INSERT INTO desktop_automation_results (agent_id, session_id, run_id, result_json)
              SELECT c.agent_id, c.session_id, c.run_id, ? ${eligible} ON CONFLICT DO NOTHING`,
        args: [JSON.stringify(desktopAutomationResultSchema.parse(result)), input.agentId, input.sessionId, input.runId, input.source],
    })
}

export const desktopAutomationResultJson = sql<string | null>`CASE WHEN ${sessions.source} IN ('schedule', 'trigger') THEN (
    SELECT a.result_json FROM desktop_automation_results a WHERE a.agent_id = ${sessions.agentId} AND a.session_id = ${sessions.id}
) END`

export function parseStoredDesktopAutomationResult(value: string | null): DesktopAutomationResult | undefined {
    if (!value) return undefined
    try { return desktopAutomationResultSchema.safeParse(JSON.parse(value)).data } catch { return undefined }
}
