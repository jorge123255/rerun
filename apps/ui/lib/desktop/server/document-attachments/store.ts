import 'server-only'
import type { Client, Row } from '@libsql/client'
import { DESKTOP_DOCUMENT_MAX_FILES, DESKTOP_DOCUMENT_TOTAL_MAX_BYTES, desktopDocumentAttachmentSchema, desktopDocumentAdmissionSchema, desktopDocumentSelectionSchema, type DesktopDocumentScope } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopDocumentAttachmentRecord, DesktopDocumentAdmissionRecord, DesktopDocumentStore } from './types'

export function desktopDocumentTables(owner: 'coworker' | 'foreman') {
    const prefix = owner === 'foreman' ? 'desktop_foreman_document' : 'desktop_document'
    return { attachments: `${prefix}_attachments`, blobs: `${prefix}_blobs`, images: `${prefix}_rendered_images`,
        admissions: `${prefix}_admissions`, cancellations: `${prefix}_upload_cancellations` }
}
const documentSchema = (owner: 'coworker' | 'foreman') => {
    const tables = desktopDocumentTables(owner)
    const agent = owner === 'coworker' ? 'REFERENCES desktop_agents(id) ON DELETE CASCADE' : "CHECK(agent_id='foreman')"
    const tab = owner === 'foreman' ? 'REFERENCES desktop_foreman_chats(chat_id) ON DELETE CASCADE' : ''
    return `
CREATE TABLE IF NOT EXISTS ${tables.attachments} (
 attachment_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL ${agent},
 tab_uid TEXT NOT NULL ${tab}, session_id TEXT, fingerprint TEXT NOT NULL, name TEXT NOT NULL,
 mime_type TEXT NOT NULL, kind TEXT NOT NULL, byte_length INTEGER NOT NULL, sha256 TEXT NOT NULL,
 conversion TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 1,
 position INTEGER NOT NULL DEFAULT 0, uploaded INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0,
 revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${tables.blobs} (
 attachment_id TEXT PRIMARY KEY REFERENCES ${tables.attachments}(attachment_id) ON DELETE CASCADE,
 sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 16777216),
 bytes BLOB NOT NULL CHECK(length(bytes)=byte_length)
);
CREATE TABLE IF NOT EXISTS ${tables.images} (
 attachment_id TEXT PRIMARY KEY REFERENCES ${tables.blobs}(attachment_id) ON DELETE CASCADE,
 sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 8388608),
 bytes BLOB NOT NULL CHECK(length(bytes)=byte_length)
);
CREATE TABLE IF NOT EXISTS ${tables.admissions} (
 admission_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL ${agent},
 tab_uid TEXT NOT NULL ${tab}, session_id TEXT, fingerprint TEXT NOT NULL, selection TEXT NOT NULL,
 admission TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ${tables.cancellations} (
 attachment_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL ${agent},
 tab_uid TEXT NOT NULL ${tab}, session_id TEXT
);`
}
export const desktopDocumentAttachmentsSchemaSql = documentSchema('coworker')
export async function ensureDesktopDocumentAttachmentsSchema(db: Client) {
    await db.executeMultiple(desktopDocumentAttachmentsSchemaSql + documentSchema('foreman'))
}
export const documentConflict = () => new DesktopHttpError(409, 'This attachment or selected message changed. Restore it before retrying.')
export const documentScopeArgs = (scope: DesktopDocumentScope) => [scope.agentId, scope.tabUid, scope.sessionId ?? null]
export const documentScopeMatches = (row: Row, scope: DesktopDocumentScope) => row.agent_id === scope.agentId && row.tab_uid === scope.tabUid && (row.session_id ?? undefined) === scope.sessionId
const writes = new WeakMap<Client, Promise<void>>()
export async function documentTransaction<T>(db: Client, work: (tx: Awaited<ReturnType<Client['transaction']>>) => Promise<T>): Promise<T> {
    const next = (writes.get(db) ?? Promise.resolve()).then(async () => {
        const tx = await db.transaction('write')
        try { const result = await work(tx); await tx.commit(); return result }
        catch (error) { await tx.rollback().catch(() => {}); throw error }
        finally { tx.close() }
    })
    const tail = next.then(() => {}, () => {})
    writes.set(db, tail)
    void tail.then(() => { if (writes.get(db) === tail) writes.delete(db) })
    return next
}
function decode(row: Row): DesktopDocumentAttachmentRecord {
    return { fingerprint: String(row.fingerprint), deletion: Number(row.deleting) !== 0, attachment: desktopDocumentAttachmentSchema.parse({
        attachmentId: row.attachment_id, scope: { agentId: row.agent_id, tabUid: row.tab_uid, ...(row.session_id == null ? {} : { sessionId: row.session_id }) },
        name: row.name, mimeType: row.mime_type, kind: row.kind, byteLength: Number(row.byte_length), sha256: row.sha256,
        conversion: JSON.parse(String(row.conversion)), admitted: Number(row.admitted) === 1, selected: Number(row.selected) === 1,
        position: Number(row.position), uploaded: Number(row.uploaded) === 1, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    }) }
}
function admissionOf(row: Row, scope: DesktopDocumentScope): DesktopDocumentAdmissionRecord {
    if (!documentScopeMatches(row, scope)) throw documentConflict()
    return { scope, fingerprint: String(row.fingerprint), selection: desktopDocumentSelectionSchema.parse(JSON.parse(String(row.selection))), admission: desktopDocumentAdmissionSchema.parse(JSON.parse(String(row.admission))) }
}
export function desktopDocumentStore(db: Client, owner: 'coworker' | 'foreman' = 'coworker'): DesktopDocumentStore {
    const tables = desktopDocumentTables(owner)
    return {
        reserve: record => documentTransaction(db, async tx => {
            const a = record.attachment
            if ((await tx.execute({ sql: `SELECT 1 FROM ${tables.cancellations} WHERE attachment_id=?`, args: [a.attachmentId] })).rows.length) throw documentConflict()
            const previous = (await tx.execute({ sql: `SELECT * FROM ${tables.attachments} WHERE attachment_id=?`, args: [a.attachmentId] })).rows[0]
            if (previous) {
                if (!documentScopeMatches(previous, a.scope) || previous.fingerprint !== record.fingerprint || Number(previous.deleting)) throw documentConflict()
                return { record: decode(previous), created: false }
            }
            const cap = (await tx.execute({ sql: `SELECT COUNT(*) AS count, COALESCE(SUM(byte_length),0) AS total FROM ${tables.attachments} WHERE agent_id=? AND tab_uid=? AND selected=1 AND deleting=0`, args: [a.scope.agentId, a.scope.tabUid] })).rows[0]!
            if (Number(cap.count) >= DESKTOP_DOCUMENT_MAX_FILES || Number(cap.total) + a.byteLength > DESKTOP_DOCUMENT_TOTAL_MAX_BYTES) throw new DesktopHttpError(413, 'Attachments can be up to 48 MB across ten files.')
            await tx.execute({ sql: `INSERT INTO ${tables.attachments}(attachment_id,agent_id,tab_uid,session_id,fingerprint,name,mime_type,kind,byte_length,sha256,conversion,admitted,selected,position,uploaded,deleting,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                args: [a.attachmentId, ...documentScopeArgs(a.scope), record.fingerprint, a.name, a.mimeType, a.kind, a.byteLength, a.sha256, JSON.stringify(a.conversion), 0, 1, a.position, 0, 0, a.revision, a.createdAt, a.updatedAt] })
            return { record, created: true }
        }),
        async read(scope, id) {
            const row = (await db.execute({ sql: `SELECT * FROM ${tables.attachments} WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND session_id IS ?`, args: [id, ...documentScopeArgs(scope)] })).rows[0]
            return row ? decode(row) : null
        },
        async list(scope) {
            return (await db.execute({ sql: `SELECT * FROM ${tables.attachments} WHERE agent_id=? AND tab_uid=? AND session_id IS ? AND selected=1 AND deleting=0 ORDER BY position,created_at,attachment_id`, args: documentScopeArgs(scope) })).rows.map(decode)
        },
        async save(record, revision) {
            const a = record.attachment
            const result = await db.execute({ sql: `UPDATE ${tables.attachments} SET conversion=?,uploaded=?,revision=?,updated_at=? WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND revision=? AND fingerprint=? AND deleting=0 AND admitted=0`,
                args: [JSON.stringify(a.conversion), a.uploaded ? 1 : 0, a.revision, a.updatedAt, a.attachmentId, ...documentScopeArgs(a.scope), revision, record.fingerprint] })
            if (result.rowsAffected !== 1) throw documentConflict()
        },
        async detach(scope, id, revision) {
            const result = await db.execute({ sql: `UPDATE ${tables.attachments} SET selected=0 WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND revision=? AND deleting=0`, args: [id, ...documentScopeArgs(scope), revision] })
            if (result.rowsAffected !== 1) throw documentConflict()
        },
        async reserveDiscard(scope, id, revision) {
            const result = await db.execute({ sql: `UPDATE ${tables.attachments} SET deleting=1,selected=0 WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND revision=? AND admitted=0 AND (deleting=1 OR json_extract(conversion,'$.state')<>'converting')`, args: [id, ...documentScopeArgs(scope), revision] })
            if (result.rowsAffected !== 1) throw documentConflict()
        },
        async discard(scope, id) {
            const result = await db.execute({ sql: `UPDATE ${tables.attachments} SET deleting=2,selected=0 WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND deleting IN (1,2) AND admitted=0`, args: [id, ...documentScopeArgs(scope)] })
            if (result.rowsAffected !== 1) throw documentConflict()
        },
        async readAdmission(scope, id) {
            const row = (await db.execute({ sql: `SELECT * FROM ${tables.admissions} WHERE admission_id=?`, args: [id] })).rows[0]
            return row ? admissionOf(row, scope) : null
        },
        admit: (record, expected) => documentTransaction(db, async tx => {
            const old = (await tx.execute({ sql: `SELECT * FROM ${tables.admissions} WHERE admission_id=?`, args: [record.selection.admissionId] })).rows[0]
            if (old) { const prior = admissionOf(old, record.scope); if (prior.fingerprint !== record.fingerprint) throw documentConflict(); return prior }
            for (const item of expected) {
                const result = await tx.execute({ sql: `UPDATE ${tables.attachments} SET admitted=1 WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND revision=? AND fingerprint=? AND deleting=0 AND selected=1 AND uploaded=1 AND json_extract(conversion,'$.state')='ready'`, args: [item.attachment.attachmentId, ...documentScopeArgs(item.attachment.scope), item.attachment.revision, item.fingerprint] })
                if (result.rowsAffected !== 1) throw documentConflict()
            }
            await tx.execute({ sql: `INSERT INTO ${tables.admissions}(admission_id,agent_id,tab_uid,session_id,fingerprint,selection,admission) VALUES(?,?,?,?,?,?,?)`, args: [record.selection.admissionId, ...documentScopeArgs(record.scope), record.fingerprint, JSON.stringify(record.selection), JSON.stringify(record.admission)] })
            return record
        }),
        consume: (scope, id) => documentTransaction(db, async tx => {
            const row = (await tx.execute({ sql: `SELECT * FROM ${tables.admissions} WHERE admission_id=?`, args: [id] })).rows[0]
            if (!row) throw documentConflict()
            const record = admissionOf(row, scope)
            for (const reference of record.admission.references) await tx.execute({ sql: `UPDATE ${tables.attachments} SET selected=0 WHERE attachment_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND sha256=? AND admitted=1`, args: [reference.attachmentId, ...documentScopeArgs(reference.scope), reference.sha256] })
            await tx.execute({ sql: `UPDATE ${tables.admissions} SET consumed=1 WHERE admission_id=?`, args: [id] })
        }),
        cancelUpload: (scope, id) => documentTransaction(db, async tx => {
            const record = (await tx.execute({ sql: `SELECT * FROM ${tables.attachments} WHERE attachment_id=?`, args: [id] })).rows[0]
            if (record && (!documentScopeMatches(record, scope) || Number(record.admitted) || Number(record.uploaded))) throw documentConflict()
            const old = (await tx.execute({ sql: `SELECT * FROM ${tables.cancellations} WHERE attachment_id=?`, args: [id] })).rows[0]
            if (old && !documentScopeMatches(old, scope)) throw documentConflict()
            await tx.execute({ sql: `INSERT INTO ${tables.cancellations}(attachment_id,agent_id,tab_uid,session_id) VALUES(?,?,?,?) ON CONFLICT(attachment_id) DO NOTHING`, args: [id, ...documentScopeArgs(scope)] })
            if (record) {
                await tx.execute({ sql: `UPDATE ${tables.attachments} SET selected=0,deleting=2 WHERE attachment_id=?`, args: [id] })
                await tx.execute({ sql: `DELETE FROM ${tables.blobs} WHERE attachment_id=?`, args: [id] })
            }
        }),
    }
}
