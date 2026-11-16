import 'server-only'
import type { Client } from '@libsql/client'

// One more tool service: the owner's read-only GitHub token, for reading their private repositories
// in the Chief of Staff's intake.
export async function initializeDesktopRound71(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 71, id = 'github-read-token'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                CREATE TABLE desktop_auxiliary_credentials_next (
                    purpose TEXT PRIMARY KEY CHECK(purpose IN ('search','keirolabs-search','browser-use-search','keenable-search','embedding','local-embedding','transcription','elevenlabs-transcription','github-read')),
                    revision TEXT NOT NULL, ciphertext TEXT);
                INSERT INTO desktop_auxiliary_credentials_next(purpose,revision,ciphertext)
                    SELECT purpose,revision,ciphertext FROM desktop_auxiliary_credentials;
                DROP TABLE desktop_auxiliary_credentials;
                ALTER TABLE desktop_auxiliary_credentials_next RENAME TO desktop_auxiliary_credentials;
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
