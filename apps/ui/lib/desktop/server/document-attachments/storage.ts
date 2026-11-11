import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { DESKTOP_DOCUMENT_MAX_BYTES, type DesktopDocumentAttachment, type DesktopDocumentScope } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { desktopDocumentTables, documentConflict, documentScopeMatches, documentTransaction } from './store'
import type { DesktopDocumentBlobStore } from './types'

const OWNER_BYTES = 256 * 1024 * 1024, WORKSPACE_BYTES = 512 * 1024 * 1024
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function owner(row: Row | undefined, scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment) {
    if (!row || !documentScopeMatches(row, scope) || row.attachment_id !== attachment.attachmentId || row.sha256 !== attachment.sha256 || Number(row.byte_length) !== attachment.byteLength) throw documentConflict()
}
function verified(row: Row, attachment: { sha256: string; byteLength: number }) {
    const value: unknown = row.bytes
    if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array)) throw documentConflict()
    if (row.sha256 !== attachment.sha256 || Number(row.byte_length) !== attachment.byteLength) throw documentConflict()
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value.slice(0) : value)
    if (bytes.byteLength !== attachment.byteLength || hash(bytes) !== attachment.sha256) throw documentConflict()
    return bytes
}
export function desktopDocumentBlobs(db: Client, ownerKind: 'coworker' | 'foreman' = 'coworker'): DesktopDocumentBlobStore {
    const tables = desktopDocumentTables(ownerKind)
    const other = desktopDocumentTables(ownerKind === 'coworker' ? 'foreman' : 'coworker')
    return {
        async put(scope, attachment, bytes, signal, rendered) {
            signal.throwIfAborted()
            if (!bytes.byteLength || bytes.byteLength > DESKTOP_DOCUMENT_MAX_BYTES || bytes.byteLength !== attachment.byteLength || hash(bytes) !== attachment.sha256) throw documentConflict()
            const image = attachment.conversion.renderedImage
            if (image ? !rendered || rendered.byteLength !== image.byteLength || hash(rendered) !== image.sha256 : rendered !== undefined) throw documentConflict()
            await documentTransaction(db, async tx => {
                const record = (await tx.execute({ sql: `SELECT * FROM ${tables.attachments} WHERE attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
                owner(record, scope, attachment)
                if (Number(record!.deleting)) throw documentConflict()
                const previous = (await tx.execute({ sql: `SELECT * FROM ${tables.blobs} WHERE attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
                if (previous) {
                    verified(previous, attachment)
                    if (image) {
                        const saved = (await tx.execute({ sql: `SELECT * FROM ${tables.images} WHERE attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
                        if (!saved) throw documentConflict()
                        verified(saved, image)
                    }
                    return
                }
                const cap = (await tx.execute({ sql: `SELECT COALESCE(SUM(b.byte_length + COALESCE(i.byte_length,0)),0) + (SELECT COALESCE(SUM(byte_length),0) FROM ${other.blobs})
                    + (SELECT COALESCE(SUM(byte_length),0) FROM ${other.images}) AS total,
                    COALESCE(SUM(CASE WHEN a.agent_id=? THEN b.byte_length + COALESCE(i.byte_length,0) ELSE 0 END),0) AS owned
                    FROM ${tables.blobs} b JOIN ${tables.attachments} a ON a.attachment_id=b.attachment_id
                    LEFT JOIN ${tables.images} i ON i.attachment_id=b.attachment_id`, args: [scope.agentId] })).rows[0]!
                const added = bytes.byteLength + (image?.byteLength ?? 0)
                if (Number(cap.total) + added > WORKSPACE_BYTES || Number(cap.owned) + added > OWNER_BYTES) throw new DesktopHttpError(413, 'Saved document storage is full. Remove unused attachments before adding another.')
                signal.throwIfAborted()
                await tx.execute({ sql: `INSERT INTO ${tables.blobs}(attachment_id,sha256,byte_length,bytes) VALUES(?,?,?,?)`, args: [attachment.attachmentId, attachment.sha256, bytes.byteLength, new Uint8Array(bytes)] })
                if (image && rendered) await tx.execute({ sql: `INSERT INTO ${tables.images}(attachment_id,sha256,byte_length,bytes) VALUES(?,?,?,?)`,
                    args: [attachment.attachmentId, image.sha256, image.byteLength, new Uint8Array(rendered)] })
            })
            signal.throwIfAborted()
        },
        async read(scope, attachment, signal) {
            signal.throwIfAborted()
            const record = (await db.execute({ sql: `SELECT * FROM ${tables.attachments} WHERE attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
            owner(record, scope, attachment)
            if (Number(record!.deleting)) throw documentConflict()
            const row = (await db.execute({ sql: `SELECT * FROM ${tables.blobs} WHERE attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
            signal.throwIfAborted()
            if (!row) throw documentConflict()
            return verified(row, attachment)
        },
        async readRenderedImage(scope, attachment, image, signal) {
            signal.throwIfAborted()
            const row = (await db.execute({ sql: `SELECT a.*, i.sha256 AS rendered_sha256, i.byte_length AS rendered_length, i.bytes AS rendered_bytes
                FROM ${tables.attachments} a JOIN ${tables.images} i ON i.attachment_id=a.attachment_id
                WHERE a.attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
            owner(row, scope, attachment)
            if (!row || Number(row.deleting)) throw documentConflict()
            signal.throwIfAborted()
            return verified({ ...row, sha256: row.rendered_sha256, byte_length: row.rendered_length, bytes: row.rendered_bytes }, image)
        },
        async delete(scope, attachment, signal) {
            await documentTransaction(db, async tx => {
                const record = (await tx.execute({ sql: `SELECT * FROM ${tables.attachments} WHERE attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
                owner(record, scope, attachment)
                if (!Number(record!.deleting) || Number(record!.admitted)) throw documentConflict()
                const row = (await tx.execute({ sql: `SELECT * FROM ${tables.blobs} WHERE attachment_id=?`, args: [attachment.attachmentId] })).rows[0]
                if (row) verified(row, attachment)
                signal.throwIfAborted()
                await tx.execute({ sql: `DELETE FROM ${tables.blobs} WHERE attachment_id=? AND sha256=?`, args: [attachment.attachmentId, attachment.sha256] })
            })
            signal.throwIfAborted()
        },
    }
}
