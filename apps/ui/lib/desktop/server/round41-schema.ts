import 'server-only'
import type { Client } from '@libsql/client'
const DESKTOP_FOREMAN_LOCAL_STARTER_SCHEMA = `
CREATE TABLE desktop_foreman_local_starter_offers (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL UNIQUE REFERENCES desktop_foreman_chats(chat_id),
    session_id TEXT NOT NULL,
    intake_request_id TEXT NOT NULL UNIQUE REFERENCES desktop_foreman_intake_completions(request_id),
    intake_fingerprint TEXT NOT NULL,
    digest TEXT NOT NULL,
    cards TEXT NOT NULL,
    withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1))
);
`

export async function initializeDesktopRound41(db: Client) {
    const version = 40
    const id = 'foreman-local-starter-offer'
    const tx = await db.transaction('write')
    try {
        const previous = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (previous && previous.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!previous) {
            await tx.execute(DESKTOP_FOREMAN_LOCAL_STARTER_SCHEMA)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } catch (error) {
        await tx.rollback()
        throw error
    } finally { tx.close() }
}
