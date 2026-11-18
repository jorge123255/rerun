import 'server-only'
import type { Client } from '@libsql/client'

// A personal Connect login and a project account can independently own the same app and label.
export async function initializeDesktopRound73(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 73, id = 'managed-app-account-modes'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                DROP INDEX desktop_managed_app_accounts_label;
                CREATE UNIQUE INDEX desktop_managed_app_accounts_project_label
                    ON desktop_managed_app_accounts(slug, label COLLATE NOCASE) WHERE user_id<>'';
                CREATE UNIQUE INDEX desktop_managed_app_accounts_connect_label
                    ON desktop_managed_app_accounts(slug, label COLLATE NOCASE) WHERE user_id='';
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
