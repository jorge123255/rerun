import { createHash } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import {
    desktopApiConnectionIdSchema,
    desktopApiConnectionRevisionSchema,
    desktopApiMutationReceiptSchema,
    desktopApiMutationResultSchema,
    type DesktopApiConnectionId,
    type DesktopApiConnectionRevision,
    type DesktopApiMutationReceipt,
    type DesktopApiMutationResult,
} from '@rerun/contracts'
import type { DesktopWorkspaceId } from '@rerun/contracts'

export const DESKTOP_API_CONNECTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_api_connection_revisions (
 workspace_id INTEGER NOT NULL, connection_id TEXT NOT NULL, revision TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,connection_id)
);
CREATE TABLE IF NOT EXISTS desktop_api_connection_receipts (
 request_id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, connection_id TEXT,
 revision TEXT, fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL, result_json TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_api_connection_workspace_idx ON desktop_api_connection_receipts(workspace_id,connection_id);`

export type DesktopApiConnectionReceiptRecord = { receipt: DesktopApiMutationReceipt; result: DesktopApiMutationResult | null }
export type DesktopApiConnectionStore = {
    read(requestId: string): Promise<DesktopApiConnectionReceiptRecord | null>
    reserve(receipt: DesktopApiMutationReceipt, result: DesktopApiMutationResult | null): Promise<{ record: DesktopApiConnectionReceiptRecord; created: boolean }>
    finish(receipt: DesktopApiMutationReceipt, result: DesktopApiMutationResult): Promise<void>
    revision(workspaceId: DesktopWorkspaceId, connectionId: DesktopApiConnectionId): Promise<DesktopApiConnectionRevision>
    setRevision(workspaceId: DesktopWorkspaceId, connectionId: DesktopApiConnectionId, expected: DesktopApiConnectionRevision | null, next: DesktopApiConnectionRevision): Promise<void>
}

const seed = (connectionId: string): DesktopApiConnectionRevision => `rev_${createHash('sha256').update(connectionId).digest('hex').slice(0, 21)}`
const transactions = new WeakMap<Client, Promise<unknown>>()
async function write<T>(db: Client, work: (tx: Transaction) => Promise<T>): Promise<T> {
    const previous = transactions.get(db) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
        const tx = await db.transaction('write')
        try {
            const result = await work(tx)
            await tx.commit()
            return result
        } catch (error) {
            await tx.rollback().catch(() => {})
            throw error
        } finally {
            tx.close()
        }
    })
    transactions.set(db, task.catch(() => {}))
    return task
}

function decode(row: Record<string, unknown>): DesktopApiConnectionReceiptRecord {
    const receipt = desktopApiMutationReceiptSchema.parse(JSON.parse(String(row.receipt_json)))
    const result = row.result_json == null ? null : desktopApiMutationResultSchema.parse(JSON.parse(String(row.result_json)))
    if (result && (result.status !== receipt.status || result.receipt.requestId !== receipt.requestId || result.receipt.fingerprint !== receipt.fingerprint)) throw new Error('API connection receipt/result mismatch')
    return { receipt, result }
}

async function readRow(db: Pick<Client, 'execute'> | Transaction, requestId: string): Promise<DesktopApiConnectionReceiptRecord | null> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_api_connection_receipts WHERE request_id=?', args: [requestId] })).rows[0] as Record<string, unknown> | undefined
    return row ? decode(row) : null
}

export function sqliteDesktopApiConnectionStore(db: Client): DesktopApiConnectionStore {
    return {
        read: requestId => readRow(db, requestId),
        reserve: (receipt, result) => write(db, async tx => {
            const previous = await readRow(tx, receipt.requestId)
            if (previous) {
                if (previous.receipt.fingerprint !== receipt.fingerprint) throw new Error('API connection request identity changed')
                return { record: previous, created: false }
            }
            const count = (await tx.execute('SELECT COUNT(*) AS n FROM desktop_api_connection_receipts')).rows[0]
            if (Number(count.n) >= 16_384) throw new Error('API connection receipt capacity reached')
            const now = new Date().toISOString()
            await tx.execute({
                sql: 'INSERT INTO desktop_api_connection_receipts(request_id,workspace_id,connection_id,revision,fingerprint,receipt_json,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                args: [receipt.requestId, receipt.workspaceId, receipt.connectionId, receipt.connectionRevision, receipt.fingerprint, JSON.stringify(receipt), result ? JSON.stringify(result) : null, now, now],
            })
            return { record: { receipt, result }, created: true }
        }),
        finish: (receipt, result) => write(db, async tx => {
            const previous = await readRow(tx, receipt.requestId)
            if (!previous || previous.receipt.fingerprint !== receipt.fingerprint) throw new Error('API connection request reservation changed')
            const stored = { ...result, recovered: false as const }
            if (previous.receipt.status === 'saved' && previous.result) {
                if (JSON.stringify(previous.result) !== JSON.stringify(stored)) throw new Error('API connection request already has a final result')
                return
            }
            const changed = await tx.execute({
                sql: 'UPDATE desktop_api_connection_receipts SET revision=?,receipt_json=?,result_json=?,updated_at=? WHERE request_id=? AND fingerprint=?',
                args: [receipt.connectionRevision, JSON.stringify(receipt), JSON.stringify(stored), new Date().toISOString(), receipt.requestId, receipt.fingerprint],
            })
            if (changed.rowsAffected !== 1) throw new Error('API connection request completion changed')
        }),
        async revision(workspaceId, connectionId) {
            desktopApiConnectionIdSchema.parse(connectionId)
            const row = (await db.execute({ sql: 'SELECT revision FROM desktop_api_connection_revisions WHERE workspace_id=? AND connection_id=?', args: [workspaceId, connectionId] })).rows[0]
            if (row) return desktopApiConnectionRevisionSchema.parse(row.revision)
            const initial = seed(connectionId)
            await db.execute({ sql: 'INSERT INTO desktop_api_connection_revisions(workspace_id,connection_id,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING', args: [workspaceId, connectionId, initial, new Date().toISOString()] })
            const current = (await db.execute({ sql: 'SELECT revision FROM desktop_api_connection_revisions WHERE workspace_id=? AND connection_id=?', args: [workspaceId, connectionId] })).rows[0]
            return desktopApiConnectionRevisionSchema.parse(current.revision)
        },
        setRevision: (workspaceId, connectionId, expected, next) => write(db, async tx => {
            const current = (await tx.execute({ sql: 'SELECT revision FROM desktop_api_connection_revisions WHERE workspace_id=? AND connection_id=?', args: [workspaceId, connectionId] })).rows[0]
            if (!current) {
                if (expected !== null) throw new Error('API connection revision changed')
                await tx.execute({ sql: 'INSERT INTO desktop_api_connection_revisions(workspace_id,connection_id,revision,updated_at) VALUES(?,?,?,?)', args: [workspaceId, connectionId, next, new Date().toISOString()] })
                return
            }
            if (expected === null || current.revision !== expected) throw new Error('API connection revision changed')
            const changed = await tx.execute({ sql: 'UPDATE desktop_api_connection_revisions SET revision=?,updated_at=? WHERE workspace_id=? AND connection_id=? AND revision=?', args: [next, new Date().toISOString(), workspaceId, connectionId, expected] })
            if (changed.rowsAffected !== 1) throw new Error('API connection revision changed')
        }),
    }
}

export function memoryDesktopApiConnectionStore(): DesktopApiConnectionStore {
    const receipts = new Map<string, DesktopApiConnectionReceiptRecord>()
    const revisions = new Map<string, DesktopApiConnectionRevision>()
    return {
        async read(requestId) { return receipts.get(requestId) ?? null },
        async reserve(receipt, result) {
            const previous = receipts.get(receipt.requestId)
            if (previous) {
                if (previous.receipt.fingerprint !== receipt.fingerprint) throw new Error('API connection request identity changed')
                return { record: previous, created: false }
            }
            const record = { receipt, result }
            receipts.set(receipt.requestId, record)
            return { record, created: true }
        },
        async finish(receipt, result) {
            const previous = receipts.get(receipt.requestId)
            if (!previous || previous.receipt.fingerprint !== receipt.fingerprint) throw new Error('API connection request reservation changed')
            if (previous.receipt.status === 'saved' && previous.result && JSON.stringify(previous.result) !== JSON.stringify({ ...result, recovered: false })) throw new Error('API connection request already has a final result')
            receipts.set(receipt.requestId, { receipt, result: { ...result, recovered: false } })
        },
        async revision(workspaceId, connectionId) {
            const key = `${workspaceId}:${connectionId}`
            const current = revisions.get(key)
            if (current) return current
            const initial = seed(connectionId)
            revisions.set(key, initial)
            return initial
        },
        async setRevision(workspaceId, connectionId, expected, next) {
            const key = `${workspaceId}:${connectionId}`
            const current = revisions.get(key)
            if (!current) {
                if (expected !== null) throw new Error('API connection revision changed')
                revisions.set(key, next)
                return
            }
            if (expected === null || current !== expected) throw new Error('API connection revision changed')
            revisions.set(key, next)
        },
    }
}
