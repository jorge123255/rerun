import 'server-only'
import type { Client } from '@libsql/client'

// Connector actions that ask first. A request is one held call (coworker, conversation, tool and
// the digest of its arguments); a rule is the person's standing answer for a tool, for one
// conversation (session_id set) or for the coworker everywhere (session_id '').
export async function initializeDesktopRound61(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 61, id = 'connector-approvals'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute(`CREATE TABLE desktop_connector_approval_requests (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                session_id TEXT NOT NULL,
                tool TEXT NOT NULL,
                kind TEXT NOT NULL,
                args_digest TEXT NOT NULL,
                preview TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                decided_at TEXT)`)
            await tx.execute('CREATE INDEX desktop_connector_approval_requests_session ON desktop_connector_approval_requests(session_id, status)')
            await tx.execute(`CREATE TABLE desktop_connector_approval_rules (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                tool TEXT NOT NULL,
                session_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(owner, tool, session_id))`)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
