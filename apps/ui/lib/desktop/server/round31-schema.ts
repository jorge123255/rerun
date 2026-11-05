import 'server-only'
import type { Client } from '@libsql/client'
import { delegationMigrationSql } from './delegation/store'
import { serviceSkillMigrationSql } from './services/skill-journal'
import { browserExportSchema } from './browser-exports/schema'
import { initializeDesktopCoworkerCalls } from './coworker-calls/db'

/** Additive steps after round28's version 5; never rewrite installed migration identities. */
export async function initializeDesktopRound31(db: Client) {
    const steps = [
        { version: 6, id: 'app-managed-skill-resources', sql: serviceSkillMigrationSql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '), table: 'desktop_service_skill_resources', column: 'publication_name' },
        { version: 7, id: 'browser-export-receipts', sql: browserExportSchema },
        { version: 8, id: 'composer-coworker-mentions', sql: '', table: 'desktop_composer_drafts', column: 'coworker_mentions' },
        { version: 9, id: 'isolated-delegated-tasks', sql: delegationMigrationSql.map(sql => sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')).join(';') },
    ]
    for (const step of steps) {
        const tx = await db.transaction('write')
        try {
            const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [step.version] })).rows[0]
            if (saved && saved.id !== step.id) throw new Error('Desktop migration identity mismatch')
            if (!saved) {
                if (step.sql) await tx.executeMultiple(step.sql)
                if (step.table && step.column) {
                    const columns = (await tx.execute(`PRAGMA table_info(${step.table})`)).rows
                    if (!columns.length) throw new Error('Desktop migration table missing')
                    if (!columns.some(row => row.name === step.column)) await tx.execute(`ALTER TABLE ${step.table} ADD COLUMN ${step.column} TEXT`)
                }
                await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [step.version, step.id] })
            }
            await tx.commit()
        } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
    }
    await initializeDesktopCoworkerCalls(db)
}
