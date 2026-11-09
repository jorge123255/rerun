import 'server-only'
import type { Client } from '@libsql/client'

const STEP = { version: 36, id: 'coworker-general-threads' }

async function ensureGeneralColumns(db: Pick<Client, 'execute'>) {
    const names = new Set((await db.execute('PRAGMA table_info(desktop_sessions)')).rows.map(row => String(row.name)))
    if (!names.has('kind')) await db.execute("ALTER TABLE desktop_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread' CHECK (kind IN ('general', 'thread'))")
    if (!names.has('first_message')) await db.execute('ALTER TABLE desktop_sessions ADD COLUMN first_message TEXT')
    await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS desktop_sessions_one_general ON desktop_sessions(agent_id) WHERE kind = 'general'")
}

export async function initializeDesktopRound38(db: Client) {
    const tx = await db.transaction('write')
    try {
        const previous = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version = ?', args: [STEP.version] })).rows[0]
        if (previous && previous.id !== STEP.id) throw new Error('Desktop migration identity mismatch')
        if (!previous) {
            await ensureGeneralColumns(tx)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version, id) VALUES(?, ?)', args: [STEP.version, STEP.id] })
        }
        await tx.commit()
    } catch (error) {
        await tx.rollback()
        throw error
    } finally { tx.close() }
}
