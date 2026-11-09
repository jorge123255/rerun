import 'server-only'
import type { Client } from '@libsql/client'

import { desktopMcpDeviceCustodySchema } from './mcp-device-custody/store'

const GENERAL = { version: 36, id: 'coworker-general-threads' }
const CUSTODY = { version: 37, id: 'mcp-device-attempt-custody' }

async function ensureGeneralColumns(db: Pick<Client, 'execute'>) {
    const names = new Set((await db.execute('PRAGMA table_info(desktop_sessions)')).rows.map(row => String(row.name)))
    if (!names.has('kind')) await db.execute("ALTER TABLE desktop_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread' CHECK (kind IN ('general', 'thread'))")
    if (!names.has('first_message')) await db.execute('ALTER TABLE desktop_sessions ADD COLUMN first_message TEXT')
    await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS desktop_sessions_one_general ON desktop_sessions(agent_id) WHERE kind = 'general'")
}

export async function initializeDesktopRound38(db: Client) {
    const tx = await db.transaction('write')
    try {
        const previous = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version = ?', args: [GENERAL.version] })).rows[0]
        if (previous && previous.id !== GENERAL.id) throw new Error('Desktop migration identity mismatch')
        if (!previous) {
            await ensureGeneralColumns(tx)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version, id) VALUES(?, ?)', args: [GENERAL.version, GENERAL.id] })
        }
        const custody = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version = ?', args: [CUSTODY.version] })).rows[0]
        if (custody && custody.id !== CUSTODY.id) throw new Error('Desktop migration identity mismatch')
        if (!custody) {
            await tx.execute(desktopMcpDeviceCustodySchema)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version, id) VALUES(?, ?)', args: [CUSTODY.version, CUSTODY.id] })
        }
        await tx.commit()
    } catch (error) {
        await tx.rollback()
        throw error
    } finally { tx.close() }
}
