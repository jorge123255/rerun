import { DESKTOP_REVIEW_PENDING_INBOX_SCHEMA } from './pending-inbox-db'
import { DESKTOP_FOREMAN_CREATION_SCHEMA_SQL } from './foreman/creation'
import 'server-only'
import type { Client } from '@libsql/client'
import { desktopDocumentAttachmentsSchemaSql } from './document-attachments/store'
import { desktopMcpSignInSchema } from './mcp-sign-in/schema'
import { desktopToolInstallSchema } from './tool-install/schema'
import { SERVICE_OAUTH_SCHEMA_SQL } from './services/oauth/store'
import { SERVICE_TRANSPORT_SCHEMA_SQL } from './services/transports/store'
import { DESKTOP_FOREMAN_SCHEMA_STATEMENTS } from './foreman/store'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from './foreman/chat-store'

export async function initializeDesktopRound33(db: Client) {
    const steps = [
        { version: 18, id: 'immutable-document-attachments', sql: desktopDocumentAttachmentsSchemaSql },
        { version: 19, id: 'chat-mcp-sign-in', sql: desktopMcpSignInSchema },
        { version: 20, id: 'reviewed-guest-tool-install', sql: desktopToolInstallSchema },
        { version: 21, id: 'catalog-service-oauth', sql: SERVICE_OAUTH_SCHEMA_SQL.join(';') },
        { version: 22, id: 'catalog-service-transport-receipts', sql: SERVICE_TRANSPORT_SCHEMA_SQL },
        { version: 23, id: 'local-foreman-plan-and-chat', sql: [DESKTOP_FOREMAN_CHAT_SCHEMA, ...DESKTOP_FOREMAN_SCHEMA_STATEMENTS, DESKTOP_FOREMAN_CREATION_SCHEMA_SQL].join(';') },
        { version: 24, id: 'mcp-install-pending-inbox', sql: DESKTOP_REVIEW_PENDING_INBOX_SCHEMA },
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
