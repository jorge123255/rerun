import 'server-only'
import type { Client, Row } from '@libsql/client'
import { desktopVoiceDraftSchema } from '@rerun/contracts'
import type { ForemanVoiceTarget } from '@rerun/contracts'
import type { DesktopVoiceStore, DesktopVoiceBlobStore, DesktopVoiceAttemptRecord } from '../voice/types'
import { createHash } from 'node:crypto'
import { DesktopHttpError } from '../auth'

export const FOREMAN_VOICE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS desktop_foreman_voice_attempts(
 attempt_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES desktop_foreman_chats(chat_id), target TEXT NOT NULL,
 record TEXT NOT NULL, fingerprint TEXT NOT NULL, bytes BLOB, epoch INTEGER NOT NULL DEFAULT 0,
 cancelled INTEGER NOT NULL DEFAULT 0, send_requested INTEGER NOT NULL DEFAULT 0, accepted_run TEXT,
 CHECK(bytes IS NULL OR length(bytes)<=2097152));
 CREATE INDEX IF NOT EXISTS desktop_foreman_voice_chat ON desktop_foreman_voice_attempts(chat_id);
 CREATE TABLE IF NOT EXISTS desktop_foreman_voice_cancellations(attempt_id TEXT PRIMARY KEY,target TEXT NOT NULL);`
const changed = () => new DesktopHttpError(409, 'This Foreman recording changed. Refresh this same attempt.')
export const voiceTargetJson = (t: ForemanVoiceTarget) => JSON.stringify([t.chat.workspaceId, t.chat.chatId, t.model.connectionId, t.model.model])
export const voiceScope = (t: ForemanVoiceTarget) => ({ agentId: 'foreman', tabUid: t.chat.chatId, sessionId: t.chat.workspaceId })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function blobBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return Uint8Array.from(value)
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    throw changed()
}
export function foremanVoiceStore(db: Client, target: ForemanVoiceTarget, epoch?: number): {
    store: DesktopVoiceStore; blobs: DesktopVoiceBlobStore; row(id: string): Promise<Row | null>; pending(): Promise<DesktopVoiceAttemptRecord | null>
} {
    const targetJson = voiceTargetJson(target)
    async function row(id: string) {
        return (await db.execute({ sql: 'SELECT * FROM desktop_foreman_voice_attempts WHERE attempt_id=? AND target=?', args: [id, targetJson] })).rows[0] ?? null
    }
    const decode = (r: Row): DesktopVoiceAttemptRecord => {
        const value = JSON.parse(String(r.record)) as DesktopVoiceAttemptRecord
        value.draft = desktopVoiceDraftSchema.parse(value.draft)
        return value
    }
    async function save(record: DesktopVoiceAttemptRecord, revision: string) {
        const result = await db.execute({
            sql: `UPDATE desktop_foreman_voice_attempts SET record=? WHERE attempt_id=? AND target=?
                AND json_extract(record,'$.draft.revision')=? AND epoch=? AND cancelled=0`,
            args: [JSON.stringify(record), record.draft.attemptId, targetJson, revision, epoch ?? -1],
        })
        if (result.rowsAffected !== 1) throw changed()
    }
    const store: DesktopVoiceStore = {
        async reserve(record) {
            const result = await db.execute({
                sql: `INSERT INTO desktop_foreman_voice_attempts(attempt_id,chat_id,target,record,fingerprint,epoch)
                    SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM desktop_foreman_voice_cancellations WHERE attempt_id=?)
                    ON CONFLICT(attempt_id) DO NOTHING`,
                args: [record.draft.attemptId, target.chat.chatId, targetJson, JSON.stringify(record), record.fingerprint, epoch ?? 0, record.draft.attemptId],
            })
            const r = await row(record.draft.attemptId)
            if (!r || r.fingerprint !== record.fingerprint || r.cancelled || Number(r.epoch) !== (epoch ?? 0)) throw changed()
            return { record: decode(r), created: result.rowsAffected === 1 }
        },
        async read(_s, id) { const r = await row(id); return r ? decode(r) : null },
        async list() {
            const result = await db.execute({ sql: 'SELECT * FROM desktop_foreman_voice_attempts WHERE target=? ORDER BY rowid DESC LIMIT 100', args: [targetJson] })
            return result.rows.map(decode)
        },
        save,
        async reserveDiscard(_s, id, revision) {
            const r = await row(id)
            if (!r || r.send_requested || r.accepted_run) throw changed()
            const rec = decode(r); rec.deletion = 'pending'
            await save(rec, revision)
        },
        async discard(_s, id, revision) {
            const r = await row(id)
            if (!r || r.send_requested || r.accepted_run) throw changed()
            const rec = decode(r); rec.deletion = 'complete'; rec.draft.transcript = null
            await save(rec, revision)
        },
    }
    const blobs: DesktopVoiceBlobStore = {
        async put(_s, recording, bytes, signal) {
            signal.throwIfAborted()
            if (bytes.length !== recording.byteLength || hash(bytes) !== recording.sha256) throw changed()
            const tx = await db.transaction('write')
            try {
                const r = (await tx.execute({ sql: 'SELECT * FROM desktop_foreman_voice_attempts WHERE attempt_id=? AND target=?', args: [recording.attemptId, targetJson] })).rows[0]
                if (!r || Number(r.epoch) !== epoch || r.cancelled) throw changed()
                if (r.bytes) { if (hash(blobBytes(r.bytes)) !== recording.sha256) throw changed(); await tx.commit(); return }
                const counts = (await tx.execute('SELECT COALESCE(SUM(length(bytes)),0) AS owned FROM desktop_foreman_voice_attempts')).rows[0]!
                const generic = (await tx.execute('SELECT COALESCE(SUM(byte_length),0) AS total FROM desktop_voice_blobs')).rows[0]!
                if (Number(counts.owned) + bytes.length > 32 * 1024 * 1024 || Number(counts.owned) + Number(generic.total) + bytes.length > 128 * 1024 * 1024) throw new DesktopHttpError(413, 'Saved voice audio is full. Remove unused recordings before adding another.')
                signal.throwIfAborted()
                const result = await tx.execute({ sql: 'UPDATE desktop_foreman_voice_attempts SET bytes=? WHERE attempt_id=? AND target=? AND bytes IS NULL AND epoch=? AND cancelled=0', args: [new Uint8Array(bytes), recording.attemptId, targetJson, epoch!] })
                if (result.rowsAffected !== 1) throw changed()
                await tx.commit()
            } catch (e) { await tx.rollback().catch(() => {}); throw e } finally { tx.close() }
        },
        async read(_s, recording, signal) {
            signal.throwIfAborted()
            const r = await row(recording.attemptId)
            if (!r?.bytes) throw changed()
            const bytes = blobBytes(r.bytes)
            if (bytes.length !== recording.byteLength || hash(bytes) !== recording.sha256) throw changed()
            return bytes
        },
        async delete(_s, recording, signal) {
            signal.throwIfAborted()
            const r = await row(recording.attemptId)
            if (!r || r.send_requested || r.accepted_run) throw changed()
            const result = await db.execute({ sql: 'UPDATE desktop_foreman_voice_attempts SET bytes=NULL WHERE attempt_id=? AND target=? AND send_requested=0 AND epoch=? AND cancelled=0', args: [recording.attemptId, targetJson, epoch!] })
            if (result.rowsAffected !== 1) throw changed()
        },
    }
    return {
        store, blobs, row,
        async pending() {
            // The server record is canonical across loopback-port/origin changes. Never pick a
            // different chat/model, a completed deletion, or a turn already accepted by Foreman.
            const rows = await db.execute({
                sql: `SELECT * FROM desktop_foreman_voice_attempts WHERE target=? AND accepted_run IS NULL
                    AND COALESCE(json_extract(record,'$.deletion'),'')!='complete'
                    AND json_extract(record,'$.draft.phase')!='sent' ORDER BY rowid DESC LIMIT 1`,
                args: [targetJson],
            })
            if (!rows.rows[0]) return null
            const record = decode(rows.rows[0])
            if (rows.rows[0].chat_id !== target.chat.chatId || record.draft.attemptId !== rows.rows[0].attempt_id || record.draft.recording.attemptId !== record.draft.attemptId
                || record.draft.scope.agentId !== 'foreman' || record.draft.scope.tabUid !== target.chat.chatId
                || record.draft.scope.sessionId !== target.chat.workspaceId) throw changed()
            return record
        },
    }
}
