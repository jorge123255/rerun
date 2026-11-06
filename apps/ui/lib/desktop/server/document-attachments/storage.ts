import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { DESKTOP_DOCUMENT_MAX_BYTES, type DesktopDocumentAttachment, type DesktopDocumentScope } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { documentConflict, documentScopeMatches, documentTransaction } from './store'
import type { DesktopDocumentBlobStore } from './types'

const OWNER_BYTES = 256 * 1024 * 1024, WORKSPACE_BYTES = 512 * 1024 * 1024
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function owner(row: Row | undefined, scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment) {
    if (!row || !documentScopeMatches(row, scope) || row.attachment_id !== attachment.attachmentId || row.sha256 !== attachment.sha256 || Number(row.byte_length) !== attachment.byteLength) throw documentConflict()
}
function verified(row: Row, attachment: DesktopDocumentAttachment) {
    const value: unknown = row.bytes
    if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array)) throw documentConflict()
    if (row.sha256 !== attachment.sha256 || Number(row.byte_length) !== attachment.byteLength) throw documentConflict()
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value.slice(0) : value)
    if (bytes.byteLength !== attachment.byteLength || hash(bytes) !== attachment.sha256) throw documentConflict()
    return bytes
}
export function desktopDocumentBlobs(db: Client): DesktopDocumentBlobStore {
    return {
        async put(scope, attachment, bytes, signal) {
            signal.throwIfAborted()
            if (!bytes.byteLength || bytes.byteLength > DESKTOP_DOCUMENT_MAX_BYTES || bytes.byteLength !== attachment.byteLength || hash(bytes) !== attachment.sha256) throw documentConflict()
            await documentTransaction(db, async tx => {
                const record = (await tx.execute({ sql: 'SELECT * FROM desktop_document_attachments WHERE attachment_id=?', args: [attachment.attachmentId] })).rows[0]
                owner(record, scope, attachment)
                if (Number(record!.deleting)) throw documentConflict()
                const previous = (await tx.execute({ sql: 'SELECT * FROM desktop_document_blobs WHERE attachment_id=?', args: [attachment.attachmentId] })).rows[0]
                if (previous) { verified(previous, attachment); return }
                const cap = (await tx.execute({ sql: 'SELECT COALESCE(SUM(b.byte_length),0) AS total, COALESCE(SUM(CASE WHEN a.agent_id=? THEN b.byte_length ELSE 0 END),0) AS owned FROM desktop_document_blobs b JOIN desktop_document_attachments a ON a.attachment_id=b.attachment_id', args: [scope.agentId] })).rows[0]!
                if (Number(cap.total) + bytes.byteLength > WORKSPACE_BYTES || Number(cap.owned) + bytes.byteLength > OWNER_BYTES) throw new DesktopHttpError(413, 'Saved document storage is full. Remove unused attachments before adding another.')
                signal.throwIfAborted()
                await tx.execute({ sql: 'INSERT INTO desktop_document_blobs(attachment_id,sha256,byte_length,bytes) VALUES(?,?,?,?)', args: [attachment.attachmentId, attachment.sha256, bytes.byteLength, new Uint8Array(bytes)] })
            })
            signal.throwIfAborted()
        },
        async read(scope, attachment, signal) {
            signal.throwIfAborted()
            const record = (await db.execute({ sql: 'SELECT * FROM desktop_document_attachments WHERE attachment_id=?', args: [attachment.attachmentId] })).rows[0]
            owner(record, scope, attachment)
            if (Number(record!.deleting)) throw documentConflict()
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_document_blobs WHERE attachment_id=?', args: [attachment.attachmentId] })).rows[0]
            signal.throwIfAborted()
            if (!row) throw documentConflict()
            return verified(row, attachment)
        },
        async delete(scope, attachment, signal) {
            await documentTransaction(db, async tx => {
                const record = (await tx.execute({ sql: 'SELECT * FROM desktop_document_attachments WHERE attachment_id=?', args: [attachment.attachmentId] })).rows[0]
                owner(record, scope, attachment)
                if (!Number(record!.deleting) || Number(record!.admitted)) throw documentConflict()
                const row = (await tx.execute({ sql: 'SELECT * FROM desktop_document_blobs WHERE attachment_id=?', args: [attachment.attachmentId] })).rows[0]
                if (row) verified(row, attachment)
                signal.throwIfAborted()
                await tx.execute({ sql: 'DELETE FROM desktop_document_blobs WHERE attachment_id=? AND sha256=?', args: [attachment.attachmentId, attachment.sha256] })
            })
            signal.throwIfAborted()
        },
    }
}
