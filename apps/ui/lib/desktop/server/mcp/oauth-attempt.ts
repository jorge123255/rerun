import 'server-only'
import type { Client } from '@libsql/client'

export const remoteMcpOAuthAttemptSchema = `CREATE TABLE IF NOT EXISTS desktop_remote_mcp_oauth_attempt (
 agent_id TEXT NOT NULL, name TEXT NOT NULL, registration_id TEXT NOT NULL, revision TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('browser','device')), attempt_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(agent_id,name), FOREIGN KEY(agent_id,name) REFERENCES desktop_remote_mcp(agent_id,name) ON DELETE CASCADE);`

export type McpOAuthAttempt = {
    owner: string
    name: string
    registrationId: string
    revision: string
    method: 'browser' | 'device'
    attemptId: string
}
type Query = Pick<Client, 'execute'>
const whereAttempt = 'agent_id=? AND name=? AND registration_id=? AND revision=? AND method=? AND attempt_id=?'
const identity = (attempt: McpOAuthAttempt) => [attempt.owner, attempt.name, attempt.registrationId, attempt.revision, attempt.method, attempt.attemptId]

/** One pending authorization per registration. Contains no provider data or credentials. */
export function createMcpOAuthAttempts(db: Client, now = Date.now) {
    const unavailable = () => new Error('Another MCP sign-in is already in progress, or the registration changed.')
    return {
        async reserve(attempt: McpOAuthAttempt, expiresAt: number, query: Query = db) {
            const time = now()
            if (expiresAt <= time) throw unavailable()
            const result = await query.execute({
                sql: `INSERT INTO desktop_remote_mcp_oauth_attempt(agent_id,name,registration_id,revision,method,attempt_id,expires_at)
                    SELECT agent_id,name,id,revision,?,?,? FROM desktop_remote_mcp
                    WHERE agent_id=? AND name=? AND id=? AND revision=? AND bearer IS NULL
                    ON CONFLICT(agent_id,name) DO UPDATE SET registration_id=excluded.registration_id,revision=excluded.revision,
                        method=excluded.method,attempt_id=excluded.attempt_id,expires_at=excluded.expires_at
                    WHERE desktop_remote_mcp_oauth_attempt.expires_at<=?
                        OR desktop_remote_mcp_oauth_attempt.registration_id<>excluded.registration_id
                        OR desktop_remote_mcp_oauth_attempt.revision<>excluded.revision`,
                args: [attempt.method, attempt.attemptId, expiresAt, attempt.owner, attempt.name, attempt.registrationId, attempt.revision, time],
            })
            if (result.rowsAffected !== 1) throw unavailable()
        },
        async assertCurrent(attempt: McpOAuthAttempt, query: Query = db) {
            const result = await query.execute({
                sql: `SELECT 1 FROM desktop_remote_mcp_oauth_attempt a WHERE ${whereAttempt} AND expires_at>?
                    AND EXISTS (SELECT 1 FROM desktop_remote_mcp r
                        WHERE r.agent_id=a.agent_id AND r.name=a.name AND r.id=a.registration_id AND r.revision=a.revision AND r.bearer IS NULL)`,
                args: [...identity(attempt), now()],
            })
            if (result.rows.length !== 1) throw unavailable()
        },
        async shorten(attempt: McpOAuthAttempt, expiresAt: number, query: Query) {
            const result = await query.execute({
                sql: `UPDATE desktop_remote_mcp_oauth_attempt SET expires_at=MIN(expires_at,?) WHERE ${whereAttempt} AND expires_at>?`,
                args: [expiresAt, ...identity(attempt), now()],
            })
            if (result.rowsAffected !== 1) throw unavailable()
        },
        async release(attempt: McpOAuthAttempt, query: Query = db) {
            await query.execute({ sql: `DELETE FROM desktop_remote_mcp_oauth_attempt WHERE ${whereAttempt}`, args: identity(attempt) })
        },
    }
}

export type McpOAuthAttempts = ReturnType<typeof createMcpOAuthAttempts>
