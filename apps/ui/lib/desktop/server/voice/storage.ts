import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { DESKTOP_VOICE_MAX_BYTES, desktopVoiceDispatchSchema, desktopVoiceModelChoiceSchema, desktopVoiceRecordingSchema, type DesktopVoiceScope, type DesktopVoiceRecording, type DesktopVoiceSendInput } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopVoiceBlobStore } from './types'

export const DESKTOP_VOICE_OWNER_BYTES = 32 * 1024 * 1024
export const DESKTOP_VOICE_TOTAL_BYTES = 128 * 1024 * 1024
export const desktopVoiceStorageSchemaSql = `
CREATE TABLE IF NOT EXISTS desktop_voice_blobs (
 attempt_id TEXT PRIMARY KEY REFERENCES desktop_voice_attempts(attempt_id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 tab_uid TEXT NOT NULL, session_id TEXT, recording TEXT NOT NULL, sha256 TEXT NOT NULL,
 byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 2097152), bytes BLOB NOT NULL CHECK(length(bytes)=byte_length)
);
CREATE TABLE IF NOT EXISTS desktop_voice_dispatches (
 attempt_id TEXT PRIMARY KEY REFERENCES desktop_voice_attempts(attempt_id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 tab_uid TEXT NOT NULL, original_session_id TEXT, engine_agent_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, model_choice TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('pending','complete')), session_id TEXT, run_id TEXT, message_id TEXT
);`
const unavailable = () => new DesktopHttpError(409, 'This voice recording or send belongs to another attempt.')
const scopeMatches = (row: Row, scope: DesktopVoiceScope, session = 'session_id') => row.agent_id === scope.agentId && row.tab_uid === scope.tabUid && (row[session] ?? undefined) === scope.sessionId
export const voiceRecordingJson = (recording: DesktopVoiceRecording) => JSON.stringify(desktopVoiceRecordingSchema.parse(recording))
const metadata = voiceRecordingJson
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const writes = new WeakMap<Client, Promise<void>>()
async function transaction<T>(db: Client, work: (tx: Awaited<ReturnType<Client['transaction']>>) => Promise<T>) {
    const previous = writes.get(db) ?? Promise.resolve()
    const next = previous.then(async () => {
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
function verified(row: Row, scope: DesktopVoiceScope, recording: DesktopVoiceRecording) {
    if (!scopeMatches(row, scope) || row.recording !== metadata(recording) || row.sha256 !== recording.sha256 || Number(row.byte_length) !== recording.byteLength) throw unavailable()
    const value: unknown = row.bytes
    if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array)) throw unavailable()
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value.slice(0) : value)
    if (bytes.byteLength !== recording.byteLength || hash(bytes) !== recording.sha256) throw unavailable()
    return bytes
}
export function desktopVoiceBlobs(db: Client): DesktopVoiceBlobStore {
    return {
        async put(scope, recording, bytes, signal) {
            signal.throwIfAborted()
            if (!bytes.byteLength || bytes.byteLength > DESKTOP_VOICE_MAX_BYTES || bytes.byteLength !== recording.byteLength || hash(bytes) !== recording.sha256) throw unavailable()
            await transaction(db, async tx => {
                const attempt = (await tx.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE attempt_id=?', args: [recording.attemptId] })).rows[0]
                if (!attempt || !scopeMatches(attempt, scope) || attempt.phase !== 'uploading' || attempt.recording !== metadata(recording)) throw unavailable()
                const prior = (await tx.execute({ sql: 'SELECT * FROM desktop_voice_blobs WHERE attempt_id=?', args: [recording.attemptId] })).rows[0]
                if (prior) { verified(prior, scope, recording); return }
                const counts = (await tx.execute({ sql: 'SELECT COALESCE(SUM(byte_length),0) AS total, COALESCE(SUM(CASE WHEN agent_id=? THEN byte_length ELSE 0 END),0) AS owned FROM desktop_voice_blobs', args: [scope.agentId] })).rows[0]!
                if (Number(counts.total) + bytes.byteLength > DESKTOP_VOICE_TOTAL_BYTES || Number(counts.owned) + bytes.byteLength > DESKTOP_VOICE_OWNER_BYTES) throw new DesktopHttpError(413, 'Saved voice audio is full. Remove unused recordings before adding another.')
                signal.throwIfAborted()
                await tx.execute({ sql: 'INSERT INTO desktop_voice_blobs(attempt_id,agent_id,tab_uid,session_id,recording,sha256,byte_length,bytes) VALUES(?,?,?,?,?,?,?,?)', args: [recording.attemptId, scope.agentId, scope.tabUid, scope.sessionId ?? null, metadata(recording), recording.sha256, bytes.byteLength, new Uint8Array(bytes)] })
            })
            signal.throwIfAborted()
        },
        async read(scope, recording, signal) {
            signal.throwIfAborted()
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_voice_blobs WHERE attempt_id=?', args: [recording.attemptId] })).rows[0]
            signal.throwIfAborted()
            if (!row) throw unavailable()
            return verified(row, scope, recording)
        },
        async delete(scope, recording, signal) {
            signal.throwIfAborted()
            await transaction(db, async tx => {
                const attempt = (await tx.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE attempt_id=?', args: [recording.attemptId] })).rows[0]
                if (!attempt || !scopeMatches(attempt, scope) || !['discarding', 'discarded'].includes(String(attempt.phase)) || attempt.recording !== metadata(recording)) throw unavailable()
                if ((await tx.execute({ sql: 'SELECT 1 FROM desktop_voice_dispatches WHERE attempt_id=?', args: [recording.attemptId] })).rows.length) throw unavailable()
                const row = (await tx.execute({ sql: 'SELECT * FROM desktop_voice_blobs WHERE attempt_id=?', args: [recording.attemptId] })).rows[0]
                if (!row) return
                verified(row, scope, recording); signal.throwIfAborted()
                await tx.execute({ sql: 'DELETE FROM desktop_voice_blobs WHERE attempt_id=? AND agent_id=? AND sha256=?', args: [recording.attemptId, scope.agentId, recording.sha256] })
            })
            signal.throwIfAborted()
        },
    }
}
export type VoiceDispatchRecord = {
    engineAgentId: string; fingerprint: string; modelChoice: DesktopVoiceSendInput['modelChoice'] | null
    dispatch: { sessionId: string; runId: string } | null; messageId: string | null
}
function dispatchOf(row: Row): VoiceDispatchRecord {
    const modelChoice = desktopVoiceModelChoiceSchema.nullable().parse(JSON.parse(String(row.model_choice)))
    if (!['pending', 'complete'].includes(String(row.phase))) throw unavailable()
    return { engineAgentId: String(row.engine_agent_id), fingerprint: String(row.fingerprint), modelChoice,
        dispatch: row.phase === 'complete' ? desktopVoiceDispatchSchema.parse({ sessionId: row.session_id, runId: row.run_id }) : null, messageId: row.message_id === null ? null : String(row.message_id) }
}
export function desktopVoiceDispatches(db: Client) {
    const query = (attemptId: string) => ({ sql: 'SELECT * FROM desktop_voice_dispatches WHERE attempt_id=?', args: [attemptId] })
    return {
        async read(scope: DesktopVoiceScope, attemptId: string) {
            const row = (await db.execute(query(attemptId))).rows[0]
            if (!row) return null
            if (!scopeMatches(row, scope, 'original_session_id')) throw unavailable()
            return dispatchOf(row)
        },
        async reserve(input: DesktopVoiceSendInput, engineAgentId: string) {
            return transaction(db, async tx => {
                const old = (await tx.execute(query(input.attemptId))).rows[0]
                if (old && (!scopeMatches(old, input.scope, 'original_session_id') || old.engine_agent_id !== engineAgentId)) throw unavailable()
                const saved = old ? dispatchOf(old) : null
                const modelChoice = input.modelChoice ?? saved?.modelChoice ?? null
                const fingerprint = hash(JSON.stringify([input.scope, input.attemptId, input.text, input.recording, modelChoice, engineAgentId]))
                if (saved) { if (saved.fingerprint !== fingerprint) throw unavailable(); return saved }
                const attempt = (await tx.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE attempt_id=?', args: [input.attemptId] })).rows[0]
                if (!attempt || !scopeMatches(attempt, input.scope) || attempt.phase !== 'sending' || attempt.recording !== metadata(input.recording)) throw unavailable()
                await tx.execute({ sql: "INSERT INTO desktop_voice_dispatches(attempt_id,agent_id,tab_uid,original_session_id,engine_agent_id,fingerprint,model_choice,phase) VALUES(?,?,?,?,?,?,?,'pending')", args: [input.attemptId, input.scope.agentId, input.scope.tabUid, input.scope.sessionId ?? null, engineAgentId, fingerprint, JSON.stringify(modelChoice)] })
                return { engineAgentId, fingerprint, modelChoice, dispatch: null, messageId: null }
            })
        },
        async complete(scope: DesktopVoiceScope, attemptId: string, fingerprint: string, dispatch: { sessionId: string; runId: string }, messageId: string | null) {
            desktopVoiceDispatchSchema.parse(dispatch)
            await transaction(db, async tx => {
                const row = (await tx.execute(query(attemptId))).rows[0]
                if (!row || !scopeMatches(row, scope, 'original_session_id') || row.fingerprint !== fingerprint) throw unavailable()
                const previous = dispatchOf(row)
                if (previous.dispatch) {
                    if (previous.dispatch.sessionId !== dispatch.sessionId || previous.dispatch.runId !== dispatch.runId || previous.messageId !== messageId) throw unavailable()
                    return
                }
                const result = await tx.execute({ sql: "UPDATE desktop_voice_dispatches SET phase='complete',session_id=?,run_id=?,message_id=? WHERE attempt_id=? AND fingerprint=? AND phase='pending'", args: [dispatch.sessionId, dispatch.runId, messageId, attemptId, fingerprint] })
                if (result.rowsAffected !== 1) throw unavailable()
            })
        },
    }
}
