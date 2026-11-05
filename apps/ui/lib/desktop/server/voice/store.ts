import 'server-only'

import type { Client } from '@libsql/client'
import { desktopVoiceDraftSchema } from '../../../../../../packages/contracts/src/desktop-voice.ts'
import type { DesktopVoiceAttemptRecord, DesktopVoiceStore } from './types'

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
    updated_at TEXT NOT NULL
)`

export async function ensureDesktopVoiceSchema(db: Client): Promise<void> {
    await db.execute(desktopVoiceSchemaSql)
}

function decode(row: Record<string, unknown>): DesktopVoiceAttemptRecord {
    return {
        fingerprint: String(row.fingerprint),
        draft: desktopVoiceDraftSchema.parse({
            attemptId: row.attempt_id,
            scope: { agentId: row.agent_id, tabUid: row.tab_uid, ...(row.session_id === null ? {} : { sessionId: row.session_id }) },
            phase: row.phase,
            revision: row.revision,
            recording: JSON.parse(String(row.recording)),
            transcript: row.transcript,
            error: row.error,
            messageId: row.message_id,
            updatedAt: row.updated_at,
        }),
    }
}

export function desktopVoiceStore(db: Client): DesktopVoiceStore {
    return {
        async reserve(record) {
            await ensureDesktopVoiceSchema(db)
            const { draft, fingerprint } = record
            const result = await db.execute({
                sql: `INSERT INTO desktop_voice_attempts(attempt_id,agent_id,tab_uid,session_id,fingerprint,phase,revision,recording,transcript,error,message_id,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING`,
                args: [draft.attemptId, draft.scope.agentId, draft.scope.tabUid, draft.scope.sessionId ?? null, fingerprint, draft.phase, draft.revision, JSON.stringify(draft.recording), draft.transcript, draft.error, draft.messageId, draft.updatedAt],
            })
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE attempt_id=?', args: [draft.attemptId] })).rows[0]
            if (!row) throw new Error('Voice attempt reservation failed')
            return { created: result.rowsAffected === 1, record: decode(row) }
        },
        async read(scope, attemptId) {
            await ensureDesktopVoiceSchema(db)
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE attempt_id=? AND agent_id=? AND tab_uid=?', args: [attemptId, scope.agentId, scope.tabUid] })).rows[0]
            return row ? decode(row) : null
        },
        async list(scope) {
            await ensureDesktopVoiceSchema(db)
            const rows = await db.execute({ sql: 'SELECT * FROM desktop_voice_attempts WHERE agent_id=? AND tab_uid=? ORDER BY updated_at,attempt_id', args: [scope.agentId, scope.tabUid] })
            return rows.rows.map(row => decode(row))
        },
        async save(record, expectedRevision) {
            await ensureDesktopVoiceSchema(db)
            const { draft } = record
            const result = await db.execute({
                sql: `UPDATE desktop_voice_attempts SET phase=?,revision=?,recording=?,transcript=?,error=?,message_id=?,updated_at=?
                    WHERE attempt_id=? AND agent_id=? AND tab_uid=? AND revision=?`,
                args: [draft.phase, draft.revision, JSON.stringify(draft.recording), draft.transcript, draft.error, draft.messageId, draft.updatedAt, draft.attemptId, draft.scope.agentId, draft.scope.tabUid, expectedRevision],
            })
            if (result.rowsAffected !== 1) throw new Error('Voice attempt revision conflict')
        },
        async discard(scope, attemptId) {
            await ensureDesktopVoiceSchema(db)
            await db.execute({ sql: 'DELETE FROM desktop_voice_attempts WHERE attempt_id=? AND agent_id=? AND tab_uid=?', args: [attemptId, scope.agentId, scope.tabUid] })
        },
    }
}
