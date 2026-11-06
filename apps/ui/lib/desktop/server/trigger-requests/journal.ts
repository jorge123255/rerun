import 'server-only'
import type { Client, Row } from '@libsql/client'
import { DesktopHttpError } from '../auth'
import { triggerRequestLinkSchema, triggerRequestPhaseSchema, type TriggerRequestLink, type TriggerRequestPhase, type TriggerRequestTarget } from '../../trigger-requests/types'
import { continuationId, triggerRequestKey } from './identity'

export type TriggerRequestRecord = {
    link: TriggerRequestLink; continuationId: string; decisionDigest: string | null
    phase: TriggerRequestPhase; version: number; acceptedRunId?: string | null
}
export type TriggerRequestJournal = {
    publish(link: TriggerRequestLink, canonicalAttemptId?: string): Promise<TriggerRequestRecord>
    get(key: string): Promise<TriggerRequestRecord | null>
    list(target: TriggerRequestTarget): Promise<TriggerRequestRecord[]>
    releaseUnadmitted(key: string, digest: string): Promise<TriggerRequestRecord>
    reserve(key: string, digest: string): Promise<{ row: TriggerRequestRecord; fresh: boolean }>
    transition(key: string, phase: TriggerRequestPhase, acceptedRunId?: string): Promise<TriggerRequestRecord>
}

export const TRIGGER_REQUEST_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS desktop_trigger_workspace_identity (id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS desktop_trigger_request_links_v1 (
    link_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL, event_id TEXT NOT NULL, source_run_id TEXT NOT NULL,
    source_json TEXT NOT NULL, continuation_id TEXT NOT NULL UNIQUE,
    decision_digest TEXT, phase TEXT NOT NULL DEFAULT 'pending'
      CHECK(phase IN ('pending','uncertain','accepted','superseded','stop-uncertain','stopped')),
    accepted_run_id TEXT, version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(workspace_id,agent_id,session_id,source_run_id,link_key)
);
CREATE INDEX IF NOT EXISTS desktop_trigger_request_event_v1
ON desktop_trigger_request_links_v1(workspace_id,agent_id,session_id,event_id);
CREATE TRIGGER IF NOT EXISTS desktop_trigger_request_immutable_v1
BEFORE UPDATE OF link_key,workspace_id,agent_id,session_id,event_id,source_run_id,source_json,continuation_id
ON desktop_trigger_request_links_v1 BEGIN SELECT RAISE(ABORT,'immutable webhook request source'); END;
`
function record(row: Row): TriggerRequestRecord {
    const link = triggerRequestLinkSchema.parse(JSON.parse(String(row.source_json)))
    if (triggerRequestKey(link) !== row.link_key) throw new DesktopHttpError(409, 'Webhook request source is corrupt')
    return { link, continuationId: String(row.continuation_id), decisionDigest: row.decision_digest == null ? null : String(row.decision_digest),
        phase: triggerRequestPhaseSchema.parse(row.phase), version: Number(row.version), acceptedRunId: row.accepted_run_id == null ? null : String(row.accepted_run_id) }
}
export function createTriggerRequestJournal(db: Client): TriggerRequestJournal {
    async function get(key: string) {
        const row = (await db.execute({ sql: 'SELECT * FROM desktop_trigger_request_links_v1 WHERE link_key=?', args: [key] })).rows[0]
        return row ? record(row) : null
    }
    async function required(key: string) { const row = await get(key); if (!row) throw new DesktopHttpError(404, 'Webhook request not found'); return row }
    return {
        get,
        async list(target) {
            const rows = await db.execute({ sql: 'SELECT * FROM desktop_trigger_request_links_v1 WHERE workspace_id=? AND agent_id=? AND session_id=? AND event_id=? ORDER BY created_at,link_key LIMIT 65', args: [target.workspaceId, target.agentId, target.sessionId, target.eventId] })
            if (rows.rows.length > 64) throw new DesktopHttpError(409, 'This webhook has too many linked human requests to reconcile automatically')
            return rows.rows.map(record).filter(row => row.link.engineAgentId === target.engineAgentId && row.link.engineSessionId === target.engineSessionId && row.link.triggerRunId === target.triggerRunId)
        },
        async publish(link, canonicalAttemptId) {
            link = triggerRequestLinkSchema.parse(link)
            const key = triggerRequestKey(link), now = new Date().toISOString()
            await db.execute({ sql: `INSERT INTO desktop_trigger_request_links_v1(link_key,workspace_id,agent_id,session_id,event_id,source_run_id,source_json,continuation_id,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(link_key) DO NOTHING`, args: [key, link.workspaceId, link.agentId, link.sessionId, link.eventId, link.sourceRunId, JSON.stringify(link), canonicalAttemptId ?? continuationId(link), now, now] })
            const row = await required(key)
            if (triggerRequestKey(row.link) !== key) throw new DesktopHttpError(409, 'Webhook request identity changed')
            return row
        },
        async releaseUnadmitted(key, digest) {
            const changed = await db.execute({ sql: `UPDATE desktop_trigger_request_links_v1 SET phase='pending',decision_digest=NULL,version=version+1,updated_at=? WHERE link_key=? AND phase='uncertain' AND decision_digest=? AND accepted_run_id IS NULL`, args: [new Date().toISOString(), key, digest] })
            if (changed.rowsAffected !== 1) throw new DesktopHttpError(409, 'Webhook admission changed during recovery')
            return required(key)
        },
        async reserve(key, digest) {
            const changed = await db.execute({ sql: `UPDATE desktop_trigger_request_links_v1 SET decision_digest=?,phase='uncertain',version=version+1,updated_at=? WHERE link_key=? AND phase='pending' AND decision_digest IS NULL`, args: [digest, new Date().toISOString(), key] })
            const row = await required(key)
            if (row.decisionDigest !== digest || !['uncertain', 'accepted'].includes(row.phase)) throw new DesktopHttpError(409, 'A different decision or Stop is already saved for this request')
            return { row, fresh: changed.rowsAffected === 1 }
        },
        async transition(key, phase, acceptedRunId) {
            const previous = await required(key)
            if (previous.phase === 'accepted') {
                if (phase === 'accepted' && acceptedRunId && previous.acceptedRunId !== acceptedRunId) throw new DesktopHttpError(409, 'Webhook follow-up receipt changed')
                return previous
            }
            const allowed: Record<TriggerRequestPhase, TriggerRequestPhase[]> = {
                pending: ['uncertain', 'superseded', 'stop-uncertain'], uncertain: ['accepted'],
                accepted: [], superseded: [], 'stop-uncertain': ['stopped'], stopped: [],
            }
            if (phase === previous.phase) return previous
            if (!allowed[previous.phase].includes(phase) || (phase === 'accepted' && !acceptedRunId)) throw new DesktopHttpError(409, 'This webhook request cannot make that transition')
            const updated = await db.execute({ sql: `UPDATE desktop_trigger_request_links_v1 SET phase=?,accepted_run_id=?,version=version+1,updated_at=? WHERE link_key=? AND version=? AND phase=?`, args: [phase, acceptedRunId ?? null, new Date().toISOString(), key, previous.version, previous.phase] })
            if (updated.rowsAffected !== 1) throw new DesktopHttpError(409, 'Webhook request changed. Refresh its saved outcome.')
            return required(key)
        },
    }
}
