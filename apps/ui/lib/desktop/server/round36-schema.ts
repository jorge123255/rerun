import 'server-only'
import type { Client } from '@libsql/client'
import { DESKTOP_SHARED_FILE_MUTATION_SCHEMA } from './shared-file-mutations/store'
import { desktopCoworkerShareSchema } from './coworker-share/schema'
import { DESKTOP_EXTERNAL_MCP_UI_SCHEMA_SQL } from '../external-mcp/attempt-store'
export async function initializeDesktopRound36(db: Client) {
    const steps = [
        { version: 31, id: 'shared-file-mutation-receipts', sql: DESKTOP_SHARED_FILE_MUTATION_SCHEMA },
        { version: 32, id: 'coworker-share-snapshots', sql: desktopCoworkerShareSchema },
        { version: 33, id: 'external-mcp-ui-attempts', sql: DESKTOP_EXTERNAL_MCP_UI_SCHEMA_SQL },
    ]
    for (const step of steps) {
        const tx = await db.transaction('write')
        try {
            const previous = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [step.version] })).rows[0]
            if (previous && previous.id !== step.id) throw new Error('Desktop migration identity mismatch')
            if (!previous) {
                await tx.executeMultiple(step.sql)
                await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [step.version, step.id] })
            }
            await tx.commit()
        } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
    }
}
