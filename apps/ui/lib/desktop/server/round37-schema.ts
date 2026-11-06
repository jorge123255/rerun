import 'server-only'
import type { Client } from '@libsql/client'
import { DESKTOP_COMPANY_PROFILE_SCHEMA_SQL } from './company-profile/schema'

export async function initializeDesktopRound37(db: Client) {
    const steps = [
        { version: 34, id: 'company-profile-derived-attempts', sql: DESKTOP_COMPANY_PROFILE_SCHEMA_SQL },
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
