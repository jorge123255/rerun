import 'server-only'
import type { Client } from '@libsql/client'

// The workspace default when it is a Rerun preset (Fast, Balanced, Smart). The engine keeps its own
// default as one real connection and model, which routines still run on; this one row is the app's.
export async function initializeDesktopRound64(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 64, id = 'workspace-model-preset'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute("CREATE TABLE desktop_workspace_model_preset (id INTEGER PRIMARY KEY CHECK (id = 1), tier TEXT NOT NULL CHECK (tier IN ('fast', 'balanced', 'smart')))")
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
