import 'server-only'

import type { Client } from '@libsql/client'
import { desktopDocumentAttachmentSchema } from '../../../../../../packages/contracts/src/desktop-document-attachments.ts'
import type { DesktopDocumentAttachmentRecord, DesktopDocumentStore } from './types'

export const desktopDocumentAttachmentsSchemaSql = `CREATE TABLE IF NOT EXISTS desktop_document_attachments (
    attachment_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    tab_uid TEXT NOT NULL,
    session_id TEXT,
    fingerprint TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    conversion TEXT NOT NULL,
    admitted INTEGER NOT NULL DEFAULT 0,
    revision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

export async function ensureDesktopDocumentAttachmentsSchema(db: Client): Promise<void> {
    await db.execute(desktopDocumentAttachmentsSchemaSql)
}

function decode(row: Record<string, unknown>): DesktopDocumentAttachmentRecord {
    return {
        fingerprint: String(row.fingerprint),
        attachment: desktopDocumentAttachmentSchema.parse({
            attachmentId: row.attachment_id,
            scope: { agentId: row.agent_id, tabUid: row.tab_uid, ...(row.session_id === null ? {} : { sessionId: row.session_id }) },
            name: row.name,
            mimeType: row.mime_type,
            kind: row.kind,
            byteLength: Number(row.byte_length),
            sha256: row.sha256,
            conversion: JSON.parse(String(row.conversion)),
            admitted: Number(row.admitted) === 1,
            revision: row.revision,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }),
    }
}

export function desktopDocumentStore(db: Client): DesktopDocumentStore {
    return {
        async reserve(record) {
            await ensureDesktopDocumentAttachmentsSchema(db)
            const { attachment, fingerprint } = record
            const result = await db.execute({
                sql: `INSERT INTO desktop_document_attachments(attachment_id,agent_id,tab_uid,session_id,fingerprint,name,mime_type,kind,byte_length,sha256,conversion,admitted,revision,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attachment_id) DO NOTHING`,
                args: [attachment.attachmentId, attachment.scope.agentId, attachment.scope.tabUid, attachment.scope.sessionId ?? null, fingerprint, attachment.name, attachment.mimeType, attachment.kind, attachment.byteLength, attachment.sha256, JSON.stringify(attachment.conversion), attachment.admitted ? 1 : 0, attachment.revision, attachment.createdAt, attachment.updatedAt],
            })
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_document_attachments WHERE attachment_id=?', args: [attachment.attachmentId] })).rows[0]
            if (!row) throw new Error('Document reservation failed')
            return { created: result.rowsAffected === 1, record: decode(row) }
        },
        async read(scope, attachmentId) {
            await ensureDesktopDocumentAttachmentsSchema(db)
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_document_attachments WHERE attachment_id=? AND agent_id=? AND tab_uid=?', args: [attachmentId, scope.agentId, scope.tabUid] })).rows[0]
            return row ? decode(row) : null
        },
        async list(scope) {
            await ensureDesktopDocumentAttachmentsSchema(db)
            const rows = await db.execute({ sql: 'SELECT * FROM desktop_document_attachments WHERE agent_id=? AND tab_uid=? ORDER BY created_at,attachment_id', args: [scope.agentId, scope.tabUid] })
            return rows.rows.map(row => decode(row))
        },
        async save(record, expectedRevision) {
            await ensureDesktopDocumentAttachmentsSchema(db)
            const { attachment } = record
            const result = await db.execute({
                sql: `UPDATE desktop_document_attachments SET conversion=?,admitted=?,revision=?,updated_at=? WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND revision=?`,
                args: [JSON.stringify(attachment.conversion), attachment.admitted ? 1 : 0, attachment.revision, attachment.updatedAt, attachment.attachmentId, attachment.scope.agentId, attachment.scope.tabUid, expectedRevision],
            })
            if (result.rowsAffected !== 1) throw new Error('Document revision conflict')
        },
        async discard(scope, attachmentId) {
            await ensureDesktopDocumentAttachmentsSchema(db)
            await db.execute({ sql: 'DELETE FROM desktop_document_attachments WHERE attachment_id=? AND agent_id=? AND tab_uid=?', args: [attachmentId, scope.agentId, scope.tabUid] })
        },
        async bytesUsed(scope) {
            await ensureDesktopDocumentAttachmentsSchema(db)
            const result = await db.execute({ sql: 'SELECT COALESCE(SUM(byte_length),0) AS total FROM desktop_document_attachments WHERE agent_id=? AND tab_uid=?', args: [scope.agentId, scope.tabUid] })
            return Number(result.rows[0]?.total ?? 0)
        },
    }
}
