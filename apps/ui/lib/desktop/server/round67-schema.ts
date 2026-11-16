import 'server-only'
import type { Client } from '@libsql/client'

// One more tool service: memory search by a model running on this Mac (Ollama), which needs no key.
export async function initializeDesktopRound67(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 67, id = 'local-embedding'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                CREATE TABLE desktop_auxiliary_credentials_next (
                    purpose TEXT PRIMARY KEY CHECK(purpose IN ('search','keirolabs-search','keenable-search','embedding','local-embedding','transcription','elevenlabs-transcription')),
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
