import 'server-only'
import type { Client } from '@libsql/client'
import type { DelegationStore, Record, ReceiptStore, StopReceipt } from '../../../../../engine/src/desktop/delegation/types'

export const delegationMigrationSql = [
    `CREATE TABLE desktop_delegations (id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, revision TEXT NOT NULL, record TEXT NOT NULL)`,
    `CREATE TABLE desktop_delegation_stops (request_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)`,
] as const
function decode(raw: unknown): Record {
    const record = JSON.parse(String(raw)) as Record
    if (record.version !== 1 || !record.snapshot || !Array.isArray(record.snapshot.tasks) || !Array.isArray(record.resources)) throw new Error('Unsupported delegation record')
    const outputs = Array.isArray(record.outputs) ? record.outputs : record.resources.map(() => null)
    if (record.resources.length !== record.snapshot.tasks.length || outputs.length !== record.resources.length) throw new Error('Delegation record length mismatch')
    return { ...record, outputs }
}
export function delegationStore(db: Client): DelegationStore {
    const source = (r: Record) => JSON.stringify([r.snapshot.parentAgentId, r.snapshot.parentSessionId, r.snapshot.parentRunId, r.snapshot.toolCallId])
    return {
        async reserve(record) {
            const s = record.snapshot
            const result = await db.execute({ sql: 'INSERT INTO desktop_delegations(id,source,session_id,revision,record) VALUES(?,?,?,?,?) ON CONFLICT(source) DO NOTHING', args: [s.delegationId, source(record), s.parentSessionId, s.revision, JSON.stringify(record)] })
            const row = (await db.execute({ sql: 'SELECT record FROM desktop_delegations WHERE source=?', args: [source(record)] })).rows[0]
            if (!row) throw new Error('Delegation reservation unavailable')
            return { created: result.rowsAffected === 1, record: decode(row.record) }
        },
        async save(record, revision) {
            const result = await db.execute({ sql: 'UPDATE desktop_delegations SET revision=?,record=? WHERE id=? AND revision=?', args: [record.snapshot.revision, JSON.stringify(record), record.snapshot.delegationId, revision] })
            if (result.rowsAffected !== 1) throw new Error('Delegation revision conflict')
        },
        async read(id) { const row = (await db.execute({ sql: 'SELECT record FROM desktop_delegations WHERE id=?', args: [id] })).rows[0]; return row ? decode(row.record) : null },
        async list(sessionId) {
            const rows = await db.execute(sessionId ? { sql: 'SELECT record FROM desktop_delegations WHERE session_id=? ORDER BY rowid', args: [sessionId] } : 'SELECT record FROM desktop_delegations ORDER BY rowid')
            return rows.rows.map(row => decode(row.record))
        },
    }
}
export function delegationReceipts(db: Client): ReceiptStore {
    return {
        async read(requestId) { const row = (await db.execute({ sql: 'SELECT receipt FROM desktop_delegation_stops WHERE request_id=?', args: [requestId] })).rows[0]; return row ? JSON.parse(String(row.receipt)) as StopReceipt : null },
        async put(requestId, receipt) {
            await db.execute({ sql: 'INSERT INTO desktop_delegation_stops(request_id,receipt) VALUES(?,?) ON CONFLICT DO NOTHING', args: [requestId, JSON.stringify(receipt)] })
            const row = (await db.execute({ sql: 'SELECT receipt FROM desktop_delegation_stops WHERE request_id=?', args: [requestId] })).rows[0]
            if (!row || (JSON.parse(String(row.receipt)) as StopReceipt).digest !== receipt.digest) throw new Error('Stop request conflict')
        },
    }
}
