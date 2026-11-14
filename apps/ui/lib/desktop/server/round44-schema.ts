import 'server-only'
import type { Client } from '@libsql/client'

const VERSION = 44
const ID = 'keirolabs-search-credentials'

export async function initializeDesktopRound44(db: Client) {
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({
            sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [VERSION],
        })).rows[0]
        if (saved) {
            if (saved.id !== ID) throw new Error('Desktop migration identity mismatch')
        } else {
            await tx.executeMultiple(`
                CREATE TABLE desktop_auxiliary_credentials_next (
                    purpose TEXT PRIMARY KEY CHECK(purpose IN ('search','keirolabs-search','embedding','transcription')),
                    revision TEXT NOT NULL, ciphertext TEXT);
                INSERT INTO desktop_auxiliary_credentials_next(purpose,revision,ciphertext)
                    SELECT purpose,revision,ciphertext FROM desktop_auxiliary_credentials;
                DROP TABLE desktop_auxiliary_credentials;
                ALTER TABLE desktop_auxiliary_credentials_next RENAME TO desktop_auxiliary_credentials;
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [VERSION, ID] })
        }
        await tx.commit()
    } finally {
        tx.close()
    }
}
