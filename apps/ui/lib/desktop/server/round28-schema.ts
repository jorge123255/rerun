import 'server-only'
import type { Client } from '@libsql/client'
import { nativeWritebackSchema } from './native-writeback/schema'
import { brainUiStateSchema } from './brain-ui-state/schema'
import { stdioSchema } from './mcp-stdio/schema'
import { desktopServicesSchema } from './services/schema'

/** The original additive bootstrap is version 1; append numbered steps without changing it. */
export async function initializeDesktopRound28(db: Client): Promise<void> {
    await db.execute('CREATE TABLE IF NOT EXISTS desktop_schema_migrations (version INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE)')
    const steps = [{ version: 2, id: 'native-file-review', sql: nativeWritebackSchema }, { version: 3, id: 'local-mcp-programs', sql: stdioSchema }, { version: 4, id: 'brain-editor-drafts', sql: brainUiStateSchema }, { version: 5, id: 'local-app-connections', sql: desktopServicesSchema }]
    for (const step of steps) {
        const transaction = await db.transaction('write')
        try {
            const saved = (await transaction.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [step.version] })).rows[0]
            if (saved && saved.id !== step.id) throw new Error('Desktop migration identity mismatch')
            if (!saved) {
                await transaction.executeMultiple(step.sql)
                await transaction.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [step.version, step.id] })
            }
            await transaction.commit()
        } catch (error) { await transaction.rollback(); throw error } finally { transaction.close() }
    }
}
