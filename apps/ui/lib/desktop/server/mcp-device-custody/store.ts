import 'server-only'
import type { Client } from '@libsql/client'
import { createDesktopSecretCrypto, type DesktopSecretCrypto } from '../secret-requests/crypto'
import type { McpOAuthAttempt, McpOAuthAttempts } from '../mcp/oauth-attempt'
import { DEVICE_CUSTODY_LIMITS, deviceRecordSchema, parsePrivate, slotOf, type DeviceApproval, type DeviceRecord } from './model'

export const desktopMcpDeviceCustodySchema = `CREATE TABLE IF NOT EXISTS desktop_mcp_device_custody (
 workspace_id TEXT NOT NULL,
 agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 slot TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version > 0),
 sealed TEXT NOT NULL,
 PRIMARY KEY(workspace_id,agent_id,slot)
);`
export type SavedDeviceRecord = { version: number; value: DeviceRecord }
export type DeviceCustodyStore = ReturnType<typeof createDeviceCustodyStore>

/** Root allocates the additive migration. This module never opens a database or reads an ambient key. */
export function createDeviceCustodyStore(db: Client, crypto: DesktopSecretCrypto, attempts?: McpOAuthAttempts) {
    const deviceAttempt = (approval: DeviceApproval): McpOAuthAttempt => ({
        owner: approval.owner, name: approval.name, registrationId: approval.registrationId, revision: approval.revision,
        method: 'device', attemptId: approval.approvalId,
    })
    async function transaction<T>(work: (tx: Awaited<ReturnType<Client['transaction']>>) => Promise<T>) {
        const tx = await db.transaction('write')
        try { const result = await work(tx); await tx.commit(); return result }
        catch (error) { await tx.rollback().catch(() => undefined); throw error }
        finally { tx.close() }
    }
    const context = (approval: DeviceApproval, version: number) => ({
        domain: 'staging' as const, agentId: approval.owner,
        key: `mcp-device-custody-v1:${slotOf(approval)}`, version,
    })
    async function seal(approval: DeviceApproval, version: number, value: DeviceRecord) {
        const bytes = Buffer.from(JSON.stringify(parsePrivate(deviceRecordSchema, value)))
        try { return await crypto.seal(context(approval, version), bytes) }
        finally { bytes.fill(0) }
    }
    return {
        async read(approval: DeviceApproval, query: Pick<Client, 'execute'> = db): Promise<SavedDeviceRecord | null> {
            const row = (await query.execute({ sql: 'SELECT version,sealed FROM desktop_mcp_device_custody WHERE workspace_id=? AND agent_id=? AND slot=?', args: [approval.workspaceId, approval.owner, slotOf(approval)] })).rows[0]
            if (!row) return null
            let bytes: Uint8Array | undefined
            try {
                const version = Number(row.version)
                if (!Number.isSafeInteger(version) || version < 1 || String(row.sealed).length > DEVICE_CUSTODY_LIMITS.payloadBytes * 2) throw new Error()
                bytes = await crypto.open(context(approval, version), String(row.sealed))
                const value = parsePrivate(deviceRecordSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
                if (slotOf(value.approval) !== slotOf(approval)) throw new Error()
                return { version, value }
            } catch { throw new Error('MCP device custody is damaged or unavailable') }
            finally { bytes?.fill(0) }
        },
        async create(approval: DeviceApproval, value: DeviceRecord, check: () => void): Promise<boolean> {
            const sealed = await seal(approval, 1, value)
            check()
            return transaction(async tx => {
                check()
                const count = (await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_mcp_device_custody WHERE workspace_id=? AND agent_id=?', args: [approval.workspaceId, approval.owner] })).rows[0]
                if (Number(count?.n) >= DEVICE_CUSTODY_LIMITS.registrations) throw new Error('MCP device custody limit reached')
                const result = await tx.execute({ sql: 'INSERT INTO desktop_mcp_device_custody(workspace_id,agent_id,slot,version,sealed) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', args: [approval.workspaceId, approval.owner, slotOf(approval), 1, sealed] })
                if (result.rowsAffected === 1) await attempts?.reserve(deviceAttempt(approval), value.expiresAt, tx)
                check()
                return result.rowsAffected === 1
            })
        },
        async replace(approval: DeviceApproval, previous: SavedDeviceRecord, value: DeviceRecord, check: () => void, query?: Pick<Client, 'execute'>): Promise<SavedDeviceRecord> {
            const version = previous.version + 1
            const sealed = await seal(approval, version, value)
            async function replaceIn(target: Pick<Client, 'execute'>) {
                check()
                const attempt = deviceAttempt(approval)
                if (['polling', 'committing', 'connected'].includes(value.phase)) await attempts?.assertCurrent(attempt, target)
                const result = await target.execute({ sql: 'UPDATE desktop_mcp_device_custody SET version=?,sealed=? WHERE workspace_id=? AND agent_id=? AND slot=? AND version=?', args: [version, sealed, approval.workspaceId, approval.owner, slotOf(approval), previous.version] })
                if (result.rowsAffected !== 1) throw new Error('MCP device custody changed; reconcile the existing attempt')
                if (value.phase === 'waiting') await attempts?.shorten(attempt, value.expiresAt, target)
                if (['connected', 'cancelled', 'expired', 'failed'].includes(value.phase)) await attempts?.release(attempt, target)
                check()
                return { version, value }
            }
            if (query) return replaceIn(query)
            return attempts ? transaction(replaceIn) : replaceIn(db)
        },
    }
}

export function createEncryptedDeviceCustodyStore(db: Client, key: () => Buffer, attempts?: McpOAuthAttempts): DeviceCustodyStore {
    return createDeviceCustodyStore(db, createDesktopSecretCrypto(key), attempts)
}
