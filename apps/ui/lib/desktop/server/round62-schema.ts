import 'server-only'
import type { Client } from '@libsql/client'

// Managed apps (Gmail, Outlook and the like, signed in through the person's own Composio account).
// The key is sealed with the Mac's credential key. An account is one sign-in to one app; an
// attachment gives one coworker that account's tools.
export async function initializeDesktopRound62(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 62, id = 'managed-apps'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute('CREATE TABLE desktop_managed_app_key (id INTEGER PRIMARY KEY CHECK (id = 1), sealed TEXT NOT NULL, revision TEXT NOT NULL, updated_at TEXT NOT NULL)')
            await tx.execute(`CREATE TABLE desktop_managed_app_accounts (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                toolkit TEXT NOT NULL,
                name TEXT NOT NULL,
                user_id TEXT NOT NULL,
                connected_account_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
                created_at TEXT NOT NULL)`)
            await tx.execute(`CREATE TABLE desktop_managed_app_attachments (
                account_id TEXT NOT NULL REFERENCES desktop_managed_app_accounts(id) ON DELETE CASCADE,
                agent_id TEXT NOT NULL,
                PRIMARY KEY (account_id, agent_id))`)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
