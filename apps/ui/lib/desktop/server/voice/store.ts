import 'server-only'

import type { Client } from '@libsql/client'
import { desktopVoiceDraftSchema, desktopVoiceModelChoiceSchema } from '@rerun/contracts'
import type { DesktopVoiceAttemptRecord, DesktopVoiceStore } from './types'
import { desktopVoiceStorageSchemaSql, voiceRecordingJson } from './storage'

export const desktopVoiceSchemaSql = `CREATE TABLE IF NOT EXISTS desktop_voice_attempts (
    attempt_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    tab_uid TEXT NOT NULL,
    session_id TEXT,
    fingerprint TEXT NOT NULL,
    phase TEXT NOT NULL,
    revision TEXT NOT NULL,
    recording TEXT NOT NULL,
    transcript TEXT,
    error TEXT,
    message_id TEXT,
    dispatch TEXT,
    send_choice TEXT,
    updated_at TEXT NOT NULL
);${desktopVoiceStorageSchemaSql}`

export async function ensureDesktopVoiceSchema(db: Client): Promise<void> {
    await db.executeMultiple(desktopVoiceSchemaSql)
    const columns = (await db.execute('PRAGMA table_info(desktop_voice_attempts)')).rows.map(row => String(row.name))
    if (!columns.includes('dispatch')) await db.execute('ALTER TABLE desktop_voice_attempts ADD COLUMN dispatch TEXT')
    if (!columns.includes('send_choice')) await db.execute('ALTER TABLE desktop_voice_attempts ADD COLUMN send_choice TEXT')
}

function decode(row: Record<string, unknown>): DesktopVoiceAttemptRecord {
    const deletion = row.phase === 'discarding' ? 'pending' : row.phase === 'discarded' ? 'complete' : undefined
    return {
        fingerprint: String(row.fingerprint),
        ...(row.send_choice == null ? {} : { sendChoice: desktopVoiceModelChoiceSchema.nullable().parse(JSON.parse(String(row.send_choice))) }),
        ...(deletion ? { deletion } : {}),
        draft: desktopVoiceDraftSchema.parse({
            attemptId: row.attempt_id,
            scope: { agentId: row.agent_id, tabUid: row.tab_uid, ...(row.session_id === null ? {} : { sessionId: row.session_id }) },
            phase: deletion ? 'failed' : row.phase,
            revision: row.revision,
            recording: JSON.parse(String(row.recording)),
            transcript: row.transcript,
            error: deletion ? 'Discard is pending. Retry discarding this recording.' : row.error,
            messageId: row.message_id,
            ...(row.dispatch == null ? {} : { dispatch: JSON.parse(String(row.dispatch)) }),
            ...(row.send_choice == null ? {} : { sendModelChoice: desktopVoiceModelChoiceSchema.nullable().parse(JSON.parse(String(row.send_choice))) }),
            updatedAt: row.updated_at,
        }),
    }
}

export function desktopVoiceStore(db: Client): DesktopVoiceStore {
    return {
        async reserve(record) {
            const { draft, fingerprint } = record
            const result = await db.execute({
                sql: `INSERT INTO desktop_voice_attempts(attempt_id,agent_id,tab_uid,session_id,fingerprint,phase,revision,recording,transcript,error,message_id,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING`,
                args: [draft.attemptId, draft.scope.agentId, draft.scope.tabUid, draft.scope.sessionId ?? null, fingerprint, draft.phase, draft.revision, voiceRecordingJson(draft.recording), draft.transcript, draft.error, draft.messageId, draft.updatedAt],
            })
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE attempt_id=?', args: [draft.attemptId] })).rows[0]
            if (!row) throw new Error('Voice attempt reservation failed')
            return { created: result.rowsAffected === 1, record: decode(row) }
        },
        async read(scope, attemptId) {
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE attempt_id=? AND agent_id=? AND tab_uid=? AND session_id IS ?', args: [attemptId, scope.agentId, scope.tabUid, scope.sessionId ?? null] })).rows[0]
            return row ? decode(row) : null
        },
        async list(scope) {
            const rows = await db.execute({ sql: "SELECT * FROM desktop_voice_attempts WHERE agent_id=? AND tab_uid=? AND session_id IS ? AND phase<>'discarded' ORDER BY updated_at,attempt_id", args: [scope.agentId, scope.tabUid, scope.sessionId ?? null] })
            return rows.rows.map(row => decode(row))
        },
        async save(record, expectedRevision) {
            const { draft } = record
            const result = await db.execute({
                sql: `UPDATE desktop_voice_attempts SET phase=?,revision=?,transcript=?,error=?,message_id=?,dispatch=?,send_choice=COALESCE(send_choice,?),updated_at=?
                    WHERE attempt_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND revision=? AND fingerprint=? AND recording=?
                    AND (send_choice IS NULL OR send_choice=?) AND (dispatch IS NULL OR dispatch=?) AND phase NOT IN ('discarding','discarded')`,
                args: [draft.phase, draft.revision, draft.transcript, draft.error, draft.messageId, draft.dispatch ? JSON.stringify(draft.dispatch) : null, record.sendChoice === undefined ? null : JSON.stringify(record.sendChoice), draft.updatedAt, draft.attemptId, draft.scope.agentId, draft.scope.tabUid, draft.scope.sessionId ?? null, expectedRevision, record.fingerprint, voiceRecordingJson(draft.recording), record.sendChoice === undefined ? null : JSON.stringify(record.sendChoice), draft.dispatch ? JSON.stringify(draft.dispatch) : null],
            })
            if (result.rowsAffected !== 1) throw new Error('Voice attempt revision conflict')
        },
        async reserveDiscard(scope, attemptId, expectedRevision) {
            const result = await db.execute({
                sql: "UPDATE desktop_voice_attempts SET phase='discarding' WHERE attempt_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND revision=? AND phase IN ('review','transcribing','ready','failed','unavailable','discarding')",
                args: [attemptId, scope.agentId, scope.tabUid, scope.sessionId ?? null, expectedRevision],
            })
            if (result.rowsAffected !== 1) throw new Error('Voice attempt revision conflict')
        },
        async discard(scope, attemptId, expectedRevision) {
            // Retain the attempt identity so a delayed upload cannot recreate deleted audio.
            const result = await db.execute({
                sql: "UPDATE desktop_voice_attempts SET phase='discarded',transcript=NULL,error=NULL WHERE attempt_id=? AND agent_id=? AND tab_uid=? AND session_id IS ? AND revision=? AND phase IN ('discarding','discarded')",
                args: [attemptId, scope.agentId, scope.tabUid, scope.sessionId ?? null, expectedRevision],
            })
            if (result.rowsAffected !== 1) throw new Error('Voice attempt revision conflict')
        },
    }
}
