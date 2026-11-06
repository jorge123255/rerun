import 'server-only'
import type { Client } from '@libsql/client'
import { TRIGGER_REQUEST_MIGRATION_SQL } from './trigger-requests/journal'
import { desktopMcpSecretReferenceSchema } from './mcp-secret-references/schema'

export async function initializeDesktopRound34(db: Client) {
    const steps = [
        { version: 25, id: 'webhook-human-request-links', sql: TRIGGER_REQUEST_MIGRATION_SQL },
        { version: 26, id: 'mcp-secret-reference-bindings', sql: desktopMcpSecretReferenceSchema },
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
