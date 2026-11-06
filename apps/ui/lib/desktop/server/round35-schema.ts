import 'server-only'
import type { Client } from '@libsql/client'
import { DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS } from './company-discovery/store'
import { FOREMAN_VOICE_SCHEMA_SQL } from './foreman-voice/store'
import { desktopForemanDocsSchemaSql } from './foreman-docs/store'
export async function initializeDesktopRound35(db: Client) {
    const steps = [
        { version: 27, id: 'public-company-discovery', sql: DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS.join(';') },
        { version: 28, id: 'foreman-voice-attempts', sql: FOREMAN_VOICE_SCHEMA_SQL },
        { version: 29, id: 'foreman-docs-receipts', sql: desktopForemanDocsSchemaSql },
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
