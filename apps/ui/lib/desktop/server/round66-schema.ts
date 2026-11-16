import 'server-only'
import type { Client } from '@libsql/client'

// Managed app accounts: an app may have a second account, told apart by a label, and an account
// whose sign-in Composio no longer holds is kept as expired so its coworkers come back with it.
// The attachments are set aside while the accounts table is rebuilt: dropping it would drop them too.
export async function initializeDesktopRound66(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 66, id = 'managed-app-account-labels'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                CREATE TABLE desktop_managed_app_attachments_kept AS SELECT account_id,agent_id FROM desktop_managed_app_attachments;
                DROP TABLE desktop_managed_app_attachments;
                CREATE TABLE desktop_managed_app_accounts_next (
                    id TEXT PRIMARY KEY,
                    slug TEXT NOT NULL,
                    toolkit TEXT NOT NULL,
                    name TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT '',
                    user_id TEXT NOT NULL,
                    connected_account_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'expired')),
                    created_at TEXT NOT NULL);
                INSERT INTO desktop_managed_app_accounts_next(id,slug,toolkit,name,user_id,connected_account_id,status,created_at)
                    SELECT id,slug,toolkit,name,user_id,connected_account_id,status,created_at FROM desktop_managed_app_accounts;
                DROP TABLE desktop_managed_app_accounts;
                ALTER TABLE desktop_managed_app_accounts_next RENAME TO desktop_managed_app_accounts;
                CREATE UNIQUE INDEX desktop_managed_app_accounts_label ON desktop_managed_app_accounts(slug, label COLLATE NOCASE);
                CREATE TABLE desktop_managed_app_attachments (
                    account_id TEXT NOT NULL REFERENCES desktop_managed_app_accounts(id) ON DELETE CASCADE,
                    agent_id TEXT NOT NULL,
                    PRIMARY KEY (account_id, agent_id));
                INSERT INTO desktop_managed_app_attachments(account_id,agent_id) SELECT account_id,agent_id FROM desktop_managed_app_attachments_kept;
                DROP TABLE desktop_managed_app_attachments_kept;
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
