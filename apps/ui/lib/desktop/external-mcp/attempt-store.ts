import 'server-only'
import type { Client, Row } from '@libsql/client'
import { desktopExternalMcpAttemptSchema, type DesktopExternalMcpAttempt } from './attempts'
import { DesktopHttpError } from '../server/auth'

export const DESKTOP_EXTERNAL_MCP_UI_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_external_mcp_ui_attempts (
 slot TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('create','revoke','enable','disable')),
 workspace_id INTEGER NOT NULL,
 input_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_external_mcp_ui_workspace_idx ON desktop_external_mcp_ui_attempts(workspace_id,kind);`

export async function ensureDesktopExternalMcpUiSchema(db: Client) {
    await db.executeMultiple(DESKTOP_EXTERNAL_MCP_UI_SCHEMA_SQL)
}

const conflict = () => new DesktopHttpError(409, 'Another external-client request is waiting for acknowledgement.')
const slotOf = (attempt: DesktopExternalMcpAttempt): string => {
    if (attempt.kind === 'create') return `create:${attempt.input.workspaceId}`
    if (attempt.kind === 'revoke') return `revoke:${attempt.input.workspaceId}:${attempt.input.keyId}`
    return `listener:${attempt.input.workspaceId}`
}
const decode = (row: Row): DesktopExternalMcpAttempt => desktopExternalMcpAttemptSchema.parse(JSON.parse(String(row.input_json)))

export function desktopExternalMcpAttemptStore(db: Client) {
    return {
        async list(workspaceId: number): Promise<DesktopExternalMcpAttempt[]> {
            const rows = (await db.execute({ sql: 'SELECT input_json FROM desktop_external_mcp_ui_attempts WHERE workspace_id=? ORDER BY created_at,slot LIMIT 64', args: [workspaceId] })).rows
            return rows.map(decode)
        },
        async reserve(raw: DesktopExternalMcpAttempt): Promise<DesktopExternalMcpAttempt> {
            const attempt = desktopExternalMcpAttemptSchema.parse(raw)
            const slot = slotOf(attempt)
            const tx = await db.transaction('write')
            try {
                const previous = (await tx.execute({ sql: 'SELECT input_json FROM desktop_external_mcp_ui_attempts WHERE slot=?', args: [slot] })).rows[0]
                if (previous) {
                    const saved = decode(previous)
                    if (JSON.stringify(saved) !== JSON.stringify(attempt)) throw conflict()
                    await tx.commit()
                    return saved
                }
                const sameRequest = (await tx.execute({ sql: 'SELECT 1 FROM desktop_external_mcp_ui_attempts WHERE request_id=?', args: [attempt.input.requestId] })).rows[0]
                if (sameRequest) throw conflict()
                await tx.execute({ sql: 'INSERT INTO desktop_external_mcp_ui_attempts(slot,request_id,kind,workspace_id,input_json,created_at) VALUES(?,?,?,?,?,?)', args: [slot, attempt.input.requestId, attempt.kind, attempt.input.workspaceId, JSON.stringify(attempt), new Date().toISOString()] })
                await tx.commit()
                return attempt
            } catch (error) {
                await tx.rollback().catch(() => {})
                throw error
            } finally {
                tx.close()
            }
        },
        async clear(raw: DesktopExternalMcpAttempt): Promise<void> {
            const attempt = desktopExternalMcpAttemptSchema.parse(raw)
            await db.execute({ sql: 'DELETE FROM desktop_external_mcp_ui_attempts WHERE slot=? AND request_id=? AND input_json=?', args: [slotOf(attempt), attempt.input.requestId, JSON.stringify(attempt)] })
        },
    }
}
