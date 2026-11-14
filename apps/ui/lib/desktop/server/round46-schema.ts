import 'server-only'
import type { Client } from '@libsql/client'

const VERSION = 46
const ID = 'vault-credential-generations'

export async function initializeDesktopRound46(db: Client) {
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [VERSION] })).rows[0]
        if (saved && saved.id !== ID) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            // Never recycle a generation, even when the entry was removed and recreated.
            await tx.executeMultiple(`
                CREATE TABLE desktop_vault_credential_generations (
                    generation INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id TEXT NOT NULL UNIQUE REFERENCES desktop_vault_secrets(id) ON DELETE CASCADE
                );
                INSERT INTO desktop_vault_credential_generations(item_id) SELECT id FROM desktop_vault_secrets;
                CREATE TRIGGER desktop_vault_credential_created AFTER INSERT ON desktop_vault_secrets BEGIN
                    INSERT INTO desktop_vault_credential_generations(item_id) VALUES (NEW.id);
                END;
                CREATE TRIGGER desktop_vault_credential_changed AFTER UPDATE OF revision ON desktop_vault_secrets
                WHEN OLD.revision <> NEW.revision BEGIN
                    DELETE FROM desktop_vault_credential_generations WHERE item_id=NEW.id;
                    INSERT INTO desktop_vault_credential_generations(item_id) VALUES (NEW.id);
                END;
                CREATE TRIGGER desktop_vault_credential_removed AFTER DELETE ON desktop_vault_secrets BEGIN
                    DELETE FROM desktop_vault_credential_generations WHERE item_id=OLD.id;
                END;
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [VERSION, ID] })
        }
        await tx.commit()
    } finally { tx.close() }
}
