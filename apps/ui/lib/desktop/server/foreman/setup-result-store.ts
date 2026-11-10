import type { Client } from '@libsql/client'
import { projectSetupResult, type SetupPermissions, type SetupResultState } from './setup-result'

const KIND = 'result-scope'
type Exec = Pick<Client, 'execute'>

async function hasTable(db: Exec, name: string): Promise<boolean> {
    const row = (await db.execute({ sql: "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", args: [name] })).rows[0]
    return !!row
}

async function latestDetail(db: Exec, agentId: string): Promise<unknown> {
    if (!await hasTable(db, 'desktop_setup_events')) return null
    const row = (await db.execute({ sql: "SELECT detail FROM desktop_setup_events WHERE agent_id=? AND kind=? ORDER BY id DESC LIMIT 1", args: [agentId, KIND] })).rows[0]
    if (!row?.detail) return null
    try { return JSON.parse(String(row.detail)) } catch { return null }
}

async function latestCard(db: Exec, agentId: string): Promise<unknown> {
    if (!await hasTable(db, 'desktop_service_suggestion_requests')) return null
    try {
        const row = (await db.execute({
            sql: `SELECT r.choices AS choices, p.entries AS entries
                  FROM desktop_service_suggestion_requests r
                  LEFT JOIN desktop_service_suggestion_receipts p ON p.service_request_id = r.service_request_id
                  WHERE r.agent_id=? ORDER BY r.updated_at DESC LIMIT 1`,
            args: [agentId],
        })).rows[0]
        if (!row) return null
        return { choices: JSON.parse(String(row.choices)), ...(row.entries ? { entries: JSON.parse(String(row.entries)) } : {}) }
    } catch { return null }
}

export async function saveSetupResult(db: Exec, agentId: string, state: SetupResultState): Promise<void> {
    if (!await hasTable(db, 'desktop_setup_events')) return
    await db.execute({ sql: 'INSERT INTO desktop_setup_events(agent_id,kind,detail,created_at) VALUES(?,?,?,?)', args: [agentId, KIND, JSON.stringify(state), new Date().toISOString()] })
}

export async function loadSetupResult(db: Exec, agentId: string, permissions?: SetupPermissions): Promise<SetupResultState> {
    return projectSetupResult({ saved: await latestDetail(db, agentId), card: await latestCard(db, agentId), permissions })
}

export async function recordObservedServiceSetup(db: Exec, agentId: string, card: { choices?: readonly { slug: string; choice: string }[]; entries?: readonly { slug: string; name?: string; outcome?: string }[] }): Promise<void> {
    if (!await hasTable(db, 'desktop_setup_events')) return
    await saveSetupResult(db, agentId, projectSetupResult({ saved: await latestDetail(db, agentId), card }))
}
