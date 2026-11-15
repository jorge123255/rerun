import 'server-only'
import type { Client } from '@libsql/client'

// A coworker whose default is a Rerun preset (Fast, Balanced, Smart). The engine keeps a coworker's
// default as one real connection and model, which a preset is not, so the app keeps this here and
// turns it into a real pair each time a message is sent.
export async function initializeDesktopRound63(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 63, id = 'coworker-model-presets'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute("CREATE TABLE desktop_coworker_model_presets (agent_id TEXT PRIMARY KEY, tier TEXT NOT NULL CHECK (tier IN ('fast', 'balanced', 'smart')))")
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
