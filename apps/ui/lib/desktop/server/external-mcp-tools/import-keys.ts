import 'server-only'
import type { Client } from '@libsql/client'
import type { ExternalMcpScope } from '@rerun/contracts'
import { assertImportCall, IMPORT_TOOL_NAMES } from '@/lib/mcp/import-scope'

/** What an import key is granted: enough for the import tools, and no data, no deletion beyond them. */
export const DESKTOP_IMPORT_KEY_SCOPES = ['mcp:read', 'coworkers:write', 'schedules:write', 'triggers:write', 'connectors:write', 'runs:send'] as const satisfies readonly ExternalMcpScope[]

export type DesktopImportKey = { keyId: string; source: string; boundAgentId: string | null; claim: string | null }

export async function readDesktopImportKey(db: Client, keyId: string): Promise<DesktopImportKey | null> {
    const row = (await db.execute({ sql: 'SELECT key_id,source,bound_agent_id,claim FROM desktop_external_import_keys WHERE key_id=?', args: [keyId] })).rows[0]
    return row ? { keyId: String(row.key_id), source: String(row.source), boundAgentId: row.bound_agent_id === null ? null : String(row.bound_agent_id), claim: row.claim === null ? null : String(row.claim) } : null
}

export async function listDesktopImportKeyIds(db: Client): Promise<string[]> {
    return (await db.execute('SELECT key_id FROM desktop_external_import_keys')).rows.map(row => String(row.key_id))
}

/** Records that a key was made for an import. Repeating it for the same key changes nothing. */
export async function markDesktopImportKey(db: Client, keyId: string, source: string, now = new Date()): Promise<void> {
    await db.execute({ sql: 'INSERT OR IGNORE INTO desktop_external_import_keys(key_id,source,created_at) VALUES(?,?,?)', args: [keyId, source, now.toISOString()] })
}

/**
 * The checks an import key's call passes before it is dispatched, and what to do once it returns.
 * A key that is not an import key gets `null`: it is an ordinary outside-agent key.
 */
export async function admitDesktopImportCall(db: Client, keyId: string, tool: string, args: Record<string, unknown>, requestId: string) {
    const key = await readDesktopImportKey(db, keyId)
    if (!key) return null
    assertImportCall(key, tool, args)
    if (tool !== 'create_agent') return { settle: async () => {} }
    // One coworker per key: the request claims the key before the coworker exists, so a second
    // call arriving meanwhile is refused instead of making another.
    const claimed = await db.execute({ sql: 'UPDATE desktop_external_import_keys SET claim=? WHERE key_id=? AND bound_agent_id IS NULL AND (claim IS NULL OR claim=?)', args: [requestId, keyId, requestId] })
    if (claimed.rowsAffected !== 1) throw new Error('This import key is already creating its coworker.')
    return {
        async settle(agentId: string | null) {
            if (agentId) await db.execute({ sql: 'UPDATE desktop_external_import_keys SET bound_agent_id=?, claim=NULL WHERE key_id=? AND claim=? AND bound_agent_id IS NULL', args: [agentId, keyId, requestId] })
            else await db.execute({ sql: 'UPDATE desktop_external_import_keys SET claim=NULL WHERE key_id=? AND claim=? AND bound_agent_id IS NULL', args: [keyId, requestId] })
        },
    }
}

export const desktopImportToolNames = IMPORT_TOOL_NAMES
