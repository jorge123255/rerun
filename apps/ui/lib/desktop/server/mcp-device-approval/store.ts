import 'server-only'
import type { Client } from '@libsql/client'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { parsePrivate } from '../mcp-device-custody/model'
import { DEVICE_REVIEW_LIMITS, deviceReviewRecordSchema, sourceScope, type DeviceReviewRecord } from './model'

export const desktopMcpDeviceReviewSchema = `CREATE TABLE IF NOT EXISTS desktop_mcp_device_reviews (
 review_id TEXT PRIMARY KEY, source_scope TEXT NOT NULL UNIQUE,
 workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0), sealed TEXT NOT NULL
);`
export type SavedDeviceReview = { version: number; value: DeviceReviewRecord }
export type DeviceReviewStore = ReturnType<typeof createDeviceReviewStore>

export function createDeviceReviewStore(db: Client, key: () => Buffer) {
    const crypto = createDesktopSecretCrypto(key)
    const context = (workspace: string, owner: string, id: string, version: number) => ({
        domain: 'staging' as const, agentId: owner, key: JSON.stringify(['mcp-device-method-review-v1', workspace, id]), version,
    })
    async function seal(value: DeviceReviewRecord, version: number) {
        const bytes = Buffer.from(JSON.stringify(parsePrivate(deviceReviewRecordSchema, value)))
        try { return await crypto.seal(context(value.approval.workspaceId, value.approval.owner, value.reviewId, version), bytes) }
        finally { bytes.fill(0) }
    }
    async function read(workspace: string, owner: string, id: string): Promise<SavedDeviceReview | null> {
        const row = (await db.execute({ sql: 'SELECT version,sealed,source_scope FROM desktop_mcp_device_reviews WHERE workspace_id=? AND agent_id=? AND review_id=?', args: [workspace, owner, id] })).rows[0]
        if (!row) return null
        let bytes: Uint8Array | undefined
        try {
            const version = Number(row.version)
            if (!Number.isSafeInteger(version) || version < 1 || String(row.sealed).length > 131_072) throw new Error()
            bytes = await crypto.open(context(workspace, owner, id, version), String(row.sealed))
            const value = parsePrivate(deviceReviewRecordSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
            if (value.reviewId !== id || value.approval.workspaceId !== workspace || value.approval.owner !== owner || sourceScope(workspace, value.source) !== row.source_scope) throw new Error()
            return { version, value }
        } catch { throw new Error('Device method review storage is unavailable') }
        finally { bytes?.fill(0) }
    }
    return {
        read,
        async bySource(workspace: string, owner: string, scope: string) {
            const row = (await db.execute({ sql: 'SELECT review_id FROM desktop_mcp_device_reviews WHERE workspace_id=? AND agent_id=? AND source_scope=?', args: [workspace, owner, scope] })).rows[0]
            return row ? read(workspace, owner, String(row.review_id)) : null
        },
        async list(workspace: string, owner: string) {
            const rows = (await db.execute({ sql: 'SELECT review_id FROM desktop_mcp_device_reviews WHERE workspace_id=? AND agent_id=? LIMIT ?', args: [workspace, owner, DEVICE_REVIEW_LIMITS.records + 1] })).rows
            if (rows.length > DEVICE_REVIEW_LIMITS.records) throw new Error('Device method review limit exceeded')
            const values: SavedDeviceReview[] = []
            for (const row of rows) { const value = await read(workspace, owner, String(row.review_id)); if (!value) throw new Error('Device method review changed'); values.push(value) }
            return values
        },
        async create(value: DeviceReviewRecord, check: () => void) {
            const sealed = await seal(value, 1), { workspaceId, owner } = value.approval
            check()
            const tx = await db.transaction('write')
            try {
                const count = (await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_mcp_device_reviews WHERE workspace_id=? AND agent_id=?', args: [workspaceId, owner] })).rows[0]
                if (Number(count?.n) >= DEVICE_REVIEW_LIMITS.records) throw new Error()
                check()
                await tx.execute({ sql: 'INSERT INTO desktop_mcp_device_reviews(review_id,source_scope,workspace_id,agent_id,version,sealed) VALUES(?,?,?,?,1,?) ON CONFLICT(source_scope) DO NOTHING', args: [value.reviewId, sourceScope(workspaceId, value.source), workspaceId, owner, sealed] })
                check(); await tx.commit()
            } catch { await tx.rollback().catch(() => {}); throw new Error('Device method review could not be recorded') }
            finally { tx.close() }
        },
        async replace(previous: SavedDeviceReview, value: DeviceReviewRecord, check: () => void): Promise<SavedDeviceReview> {
            if (previous.value.reviewId !== value.reviewId || sourceScope(value.approval.workspaceId, previous.value.source) !== sourceScope(value.approval.workspaceId, value.source)) throw new Error('Device method review identity changed')
            const version = previous.version + 1, sealed = await seal(value, version)
            check()
            const result = await db.execute({ sql: 'UPDATE desktop_mcp_device_reviews SET version=?,sealed=? WHERE review_id=? AND workspace_id=? AND agent_id=? AND version=?', args: [version, sealed, value.reviewId, value.approval.workspaceId, value.approval.owner, previous.version] })
            if (result.rowsAffected !== 1) throw new Error('Device method review changed; reload it')
            return { version, value }
        },
    }
}
