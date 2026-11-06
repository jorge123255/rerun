import 'server-only'
import type { Client } from '@libsql/client'

export const desktopSseSchemaSql = `
CREATE UNIQUE INDEX IF NOT EXISTS desktop_remote_mcp_id ON desktop_remote_mcp(id);
CREATE TABLE IF NOT EXISTS desktop_mcp_sse_calls (
    request_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    server_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    outcome TEXT,
    UNIQUE(owner,server_id,session_id,run_id,call_id)
);
CREATE TABLE IF NOT EXISTS desktop_mcp_sse_settings (
    owner TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    request TEXT NOT NULL,
    server_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    result TEXT,
    PRIMARY KEY(owner,request_id)
);
CREATE TABLE IF NOT EXISTS desktop_mcp_sse_editors (
    owner TEXT NOT NULL,
    slot TEXT NOT NULL,
    request_id TEXT NOT NULL,
    attempt TEXT NOT NULL,
    PRIMARY KEY(owner,slot)
);`

export async function migrateDesktopSse(query: Pick<Client, 'execute' | 'executeMultiple'>) {
    const columns = (await query.execute('PRAGMA table_info(desktop_remote_mcp)')).rows
    if (!columns.length) throw new Error('The canonical MCP store is missing')
    if (!columns.some(column => column.name === 'id')) await query.execute('ALTER TABLE desktop_remote_mcp ADD COLUMN id TEXT')
    if (!columns.some(column => column.name === 'transport')) await query.execute("ALTER TABLE desktop_remote_mcp ADD COLUMN transport TEXT NOT NULL DEFAULT 'http' CHECK(transport IN ('http','sse'))")
    await query.execute('UPDATE desktop_remote_mcp SET id=lower(hex(randomblob(16))) WHERE id IS NULL')
    await query.executeMultiple(desktopSseSchemaSql)
}
