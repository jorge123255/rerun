import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopTriggerDeliveryReceipt, DesktopTriggerDeliveryStatus } from '@rerun/contracts'
import type { DesktopTriggerMutationKind, DesktopTriggerStore } from './types.js'

export const desktopTriggerStateSchema = `
CREATE TABLE IF NOT EXISTS desktop_trigger_revisions (
  slug TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_trigger_mutations (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  revision_before TEXT,
  revision_after TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_trigger_events (
  event_id TEXT PRIMARY KEY,
  attempt_fingerprint TEXT,
  local_agent_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  method TEXT NOT NULL,
  received_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  local_session_id TEXT,
  engine_session_id TEXT,
  run_id TEXT,
  revision TEXT NOT NULL,
  error TEXT,
  payload_bytes INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  captured_payload INTEGER NOT NULL,
  payload_preview TEXT NOT NULL DEFAULT '',
  UNIQUE(slug, attempt_fingerprint)
);
CREATE TABLE IF NOT EXISTS desktop_trigger_revocations (
  engine_agent_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL
);
`

function receiptOf(row: Record<string, unknown>, engineAgentId: string): DesktopTriggerDeliveryReceipt & { payloadPreview: string } {
    return {
        eventId: String(row.event_id),
        attemptFingerprint: row.attempt_fingerprint == null ? null : String(row.attempt_fingerprint),
        localAgentId: String(row.local_agent_id),
        engineAgentId,
        slug: String(row.slug),
        triggerName: String(row.trigger_name),
        method: row.method as DesktopTriggerDeliveryReceipt['method'],
        receivedAt: String(row.received_at),
        status: row.status as DesktopTriggerDeliveryStatus,
        localSessionId: row.local_session_id == null ? null : String(row.local_session_id),
        engineSessionId: row.engine_session_id == null ? null : String(row.engine_session_id),
        runId: row.run_id == null ? null : String(row.run_id),
        revision: String(row.revision),
        error: row.error == null ? null : String(row.error),
        payloadBytes: Number(row.payload_bytes) || 0,
        truncated: Number(row.truncated) === 1,
        capturedPayload: Number(row.captured_payload) === 1,
        payloadPreview: String(row.payload_preview ?? ''),
    }
}

export function nextRevision(previous: string | null): string {
    const match = previous?.match(/^r(\d+)/)
    const n = match ? Number(match[1]) + 1 : 1
    return `r${n}:${randomUUID().slice(0, 8)}`
}

export function hashPayloadFingerprint(parts: { method: string; query: string; contentType: string; body: string; explicit?: string }): string | null {
    if (!parts.explicit) return null
    return createHash('sha256').update(`v1\0${parts.explicit}\0${parts.method}\0${parts.query}\0${parts.contentType}\0${parts.body}`).digest('hex')
}

/** Additive per-coworker system DB store. Root registers schema before admissions. */
export function createDesktopTriggerStore(getClient: (engineAgentId: string) => Promise<Client>): DesktopTriggerStore {
    const ready = new Map<string, Promise<void>>()
    async function clientOf(engineAgentId: string): Promise<Client> {
        let opening = ready.get(engineAgentId)
        if (!opening) {
            opening = (async () => {
                const client = await getClient(engineAgentId)
                await client.executeMultiple(desktopTriggerStateSchema)
            })()
            ready.set(engineAgentId, opening)
        }
        await opening
        return getClient(engineAgentId)
    }

    return {
        async initialize(engineAgentId) {
            await clientOf(engineAgentId)
        },
        async getRevision(engineAgentId, slug) {
            const client = await clientOf(engineAgentId)
            const row = (await client.execute({ sql: 'SELECT revision FROM desktop_trigger_revisions WHERE slug=?', args: [slug] })).rows[0]
            return row ? String(row.revision) : null
        },
        async bumpRevision(engineAgentId, slug) {
            const client = await clientOf(engineAgentId)
            const current = await this.getRevision(engineAgentId, slug)
            const revision = nextRevision(current)
            await client.execute({
                sql: `INSERT INTO desktop_trigger_revisions(slug,revision,updated_at) VALUES(?,?,?)
                      ON CONFLICT(slug) DO UPDATE SET revision=excluded.revision, updated_at=excluded.updated_at`,
                args: [slug, revision, new Date().toISOString()],
            })
            return revision
        },
        async rememberMutation(input) {
            const client = await clientOf(input.engineAgentId)
            await client.execute({
                sql: `INSERT INTO desktop_trigger_mutations(request_id,kind,slug,revision_before,revision_after,result_json,created_at)
                      VALUES(?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`,
                args: [input.requestId, input.kind, input.slug, input.revisionBefore, input.revisionAfter, input.resultJson, new Date().toISOString()],
            })
        },
        async findMutation(engineAgentId, requestId) {
            const client = await clientOf(engineAgentId)
            const row = (await client.execute({
                sql: 'SELECT kind, slug, result_json FROM desktop_trigger_mutations WHERE request_id=?',
                args: [requestId],
            })).rows[0]
            if (!row) return null
            return { kind: String(row.kind) as DesktopTriggerMutationKind, slug: String(row.slug), resultJson: String(row.result_json) }
        },
        async recordEvent(receipt) {
            const client = await clientOf(receipt.engineAgentId)
            if (receipt.attemptFingerprint) {
                const existing = await this.findEventByFingerprint(receipt.engineAgentId, receipt.slug, receipt.attemptFingerprint)
                if (existing) return 'replay'
            }
            const result = await client.execute({
                sql: `INSERT INTO desktop_trigger_events(
                        event_id, attempt_fingerprint, local_agent_id, slug, trigger_name, method, received_at, finished_at,
                        status, local_session_id, engine_session_id, run_id, revision, error, payload_bytes, truncated, captured_payload, payload_preview
                      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
                args: [
                    receipt.eventId, receipt.attemptFingerprint, receipt.localAgentId, receipt.slug, receipt.triggerName, receipt.method,
                    receipt.receivedAt, null, receipt.status, receipt.localSessionId, receipt.engineSessionId, receipt.runId, receipt.revision,
                    receipt.error, receipt.payloadBytes, receipt.truncated ? 1 : 0, receipt.capturedPayload ? 1 : 0, receipt.payloadPreview.slice(0, 65536),
                ],
            })
            if (result.rowsAffected === 0 && receipt.attemptFingerprint) {
                const again = await this.findEventByFingerprint(receipt.engineAgentId, receipt.slug, receipt.attemptFingerprint)
                if (again) return 'replay'
            }
            return 'created'
        },
        async findEventByFingerprint(engineAgentId, slug, fingerprint) {
            const client = await clientOf(engineAgentId)
            const row = (await client.execute({
                sql: 'SELECT * FROM desktop_trigger_events WHERE slug=? AND attempt_fingerprint=?',
                args: [slug, fingerprint],
            })).rows[0]
            return row ? receiptOf(row as Record<string, unknown>, engineAgentId) : null
        },
        async getEvent(engineAgentId, eventId) {
            const client = await clientOf(engineAgentId)
            const row = (await client.execute({ sql: 'SELECT * FROM desktop_trigger_events WHERE event_id=?', args: [eventId] })).rows[0]
            return row ? receiptOf(row as Record<string, unknown>, engineAgentId) : null
        },
        async updateEvent(engineAgentId, eventId, patch) {
            const current = await this.getEvent(engineAgentId, eventId)
            if (!current) throw new Error('trigger event not found')
            const next = { ...current, ...patch }
            const client = await clientOf(engineAgentId)
            await client.execute({
                sql: `UPDATE desktop_trigger_events SET status=?, local_session_id=?, engine_session_id=?, run_id=?, error=?, finished_at=?,
                      captured_payload=?, truncated=?, payload_bytes=? WHERE event_id=?`,
                args: [
                    next.status, next.localSessionId, next.engineSessionId, next.runId, next.error,
                    next.status === 'running' || next.status === 'accepted' ? null : (patch as { finishedAt?: string }).finishedAt ?? new Date().toISOString(),
                    next.capturedPayload ? 1 : 0, next.truncated ? 1 : 0, next.payloadBytes, eventId,
                ],
            })
        },
        async listEvents(engineAgentId, slug, limit = 100) {
            const client = await clientOf(engineAgentId)
            const rows = slug
                ? (await client.execute({ sql: 'SELECT * FROM desktop_trigger_events WHERE slug=? ORDER BY received_at DESC LIMIT ?', args: [slug, limit] })).rows
                : (await client.execute({ sql: 'SELECT * FROM desktop_trigger_events ORDER BY received_at DESC LIMIT ?', args: [limit] })).rows
            return rows.map(row => {
                const { payloadPreview: _p, ...receipt } = receiptOf(row as Record<string, unknown>, engineAgentId)
                return receipt
            })
        },
        async revokeOwner(engineAgentId) {
            const client = await clientOf(engineAgentId)
            await client.execute({
                sql: 'INSERT INTO desktop_trigger_revocations(engine_agent_id,revoked_at) VALUES(?,?) ON CONFLICT(engine_agent_id) DO UPDATE SET revoked_at=excluded.revoked_at',
                args: [engineAgentId, new Date().toISOString()],
            })
        },
        async isRevoked(engineAgentId) {
            const client = await clientOf(engineAgentId)
            const row = (await client.execute({ sql: 'SELECT 1 FROM desktop_trigger_revocations WHERE engine_agent_id=?', args: [engineAgentId] })).rows[0]
            return Boolean(row)
        },
        async recoverUncertain(engineAgentId) {
            const client = await clientOf(engineAgentId)
            // Never replay provider calls. Mark in-flight admissions without a finished run as uncertain.
            await client.execute({
                sql: `UPDATE desktop_trigger_events SET status='uncertain'
                      WHERE status IN ('accepted','running') AND (run_id IS NULL OR run_id='')`,
            })
            await client.execute({
                sql: `UPDATE desktop_trigger_events SET status='uncertain'
                      WHERE status='running' AND run_id IS NOT NULL`,
            })
        },
    }
}
