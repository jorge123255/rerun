import 'server-only'
import type { Client } from '@libsql/client'

// Replies read aloud: this workspace's chosen ElevenLabs voice and whether new replies are spoken
// on their own. The key stays where it already is, in desktop_auxiliary_credentials.
export async function initializeDesktopRound68(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 68, id = 'spoken-replies'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                CREATE TABLE IF NOT EXISTS desktop_speech_settings (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    voice_id TEXT,
                    auto_read INTEGER NOT NULL DEFAULT 0 CHECK(auto_read IN (0, 1)));
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
