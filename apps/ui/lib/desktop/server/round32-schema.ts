import 'server-only'
import type { Client } from '@libsql/client'
import { migrateDesktopSse } from './mcp-sse/schema'
import { desktopVoiceSchemaSql } from './voice/store'
import { desktopSecretRequestSchema } from './secret-requests/schema'
import { DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL } from './services/accounts/schema'
import { desktopAuxiliarySchema } from './auxiliary/store'
import { DESKTOP_PORTABLE_TEMPLATE_SCHEMA_SQL } from './templates/portable-server'
import { DESKTOP_SECRET_PENDING_INBOX_SCHEMA } from './pending-inbox-db'
import { desktopSelfMcpSchema } from './self-mcp/schema'

export async function initializeDesktopRound32(db: Client) {
    const steps = [
        { version: 10, id: 'explicit-mcp-transports-and-sse-receipts', sql: '' },
        { version: 11, id: 'voice-message-attempts', sql: desktopVoiceSchemaSql },
        { version: 12, id: 'chat-credential-requests', sql: desktopSecretRequestSchema },
        { version: 13, id: 'catalog-service-accounts', sql: DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL },
        { version: 14, id: 'local-search-memory-voice-backends', sql: desktopAuxiliarySchema },
        { version: 15, id: 'portable-template-recovery', sql: DESKTOP_PORTABLE_TEMPLATE_SCHEMA_SQL },
        { version: 16, id: 'credential-request-inbox', sql: DESKTOP_SECRET_PENDING_INBOX_SCHEMA },
        { version: 17, id: 'reviewed-mcp-proposals', sql: desktopSelfMcpSchema },
    ]
    for (const step of steps) {
        const tx = await db.transaction('write')
        try {
            const previous = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [step.version] })).rows[0]
            if (previous && previous.id !== step.id) throw new Error('Desktop migration identity mismatch')
            if (!previous) {
                if (step.version === 10) await migrateDesktopSse(tx)
                else await tx.executeMultiple(step.sql)
                await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [step.version, step.id] })
            }
            await tx.commit()
        } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
    }
}
