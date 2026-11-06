import 'server-only'
import type { Client, Row } from '@libsql/client'
import { desktopCoworkerShareReceiptSchema, desktopCoworkerSnapshotManifestSchema, type DesktopCoworkerShareInclude, type DesktopCoworkerShareReceipt, type DesktopCoworkerSnapshotManifest } from '../../../../../../packages/contracts/src/desktop-coworker-share'
import type { DesktopCoworkerSnapshot } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { DesktopHttpError } from '../auth'

function refusal(status: number, message: string): never { throw new DesktopHttpError(status, message) }
function receiptOf(row: Row): DesktopCoworkerShareReceipt {
    return desktopCoworkerShareReceiptSchema.parse({ requestId: String(row.request_id), operation: String(row.operation), status: String(row.status), snapshotId: String(row.snapshot_id), recoverable: Number(row.recoverable) === 1, ...(row.reason == null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at) })
}

export function createDesktopCoworkerShareStore(db: Client) {
    async function receipt(requestId: string): Promise<DesktopCoworkerShareReceipt | null> {
        const row = (await db.execute({ sql: 'SELECT * FROM desktop_coworker_share_receipts WHERE request_id = ?', args: [requestId] })).rows[0]
        return row ? receiptOf(row) : null
    }
    async function record(requestId: string, operation: DesktopCoworkerShareReceipt['operation'], status: DesktopCoworkerShareReceipt['status'], snapshotId: string, recoverable: boolean, reason?: string) {
        await db.execute({ sql: 'INSERT INTO desktop_coworker_share_receipts(request_id,operation,snapshot_id,status,recoverable,reason,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING', args: [requestId, operation, snapshotId, status, recoverable ? 1 : 0, reason ?? null, new Date().toISOString()] })
        return (await receipt(requestId))!
    }
    return {
        receipt,
        async create(snapshot: DesktopCoworkerSnapshot, sourceAgentId?: string, include?: DesktopCoworkerShareInclude, sourceRevision?: string): Promise<{ reused: boolean }> {
            const existing = (await db.execute({ sql: 'SELECT manifest_json FROM desktop_coworker_shares WHERE snapshot_id = ?', args: [snapshot.manifest.packageKey] })).rows[0]
            if (existing) {
                if (String(existing.manifest_json) !== JSON.stringify(snapshot.manifest)) refusal(409, 'A different snapshot already uses this identity.')
                return { reused: true }
            }
            const now = new Date().toISOString()
            await db.execute({
                sql: `INSERT INTO desktop_coworker_shares
                    (snapshot_id,source_agent_id,source_revision,include_json,manifest_json,archive_blob,archive_sha256,archive_bytes,status,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                args: [snapshot.manifest.packageKey, sourceAgentId ?? snapshot.manifest.coworkers[0]!.name, sourceRevision ?? snapshot.manifest.contentDigest, JSON.stringify(include ?? {}), JSON.stringify(snapshot.manifest), snapshot.archiveBytes, snapshot.archiveSha256, snapshot.archiveBytes.length, 'active', now, now],
            })
            return { reused: false }
        },
        async readArchive(snapshotId: string): Promise<{ bytes: Buffer; sha256: string }> {
            const row = (await db.execute({ sql: 'SELECT archive_blob,archive_sha256 FROM desktop_coworker_shares WHERE snapshot_id = ? AND status = ?', args: [snapshotId, 'active'] })).rows[0]
            if (!row?.archive_blob) refusal(409, 'This local share is no longer available.')
            return { bytes: Buffer.from(row.archive_blob), sha256: String(row.archive_sha256) }
        },
        async revoke(snapshotId: string, expectedRevision: string): Promise<DesktopCoworkerShareReceipt> {
            const row = (await db.execute({ sql: 'SELECT source_revision FROM desktop_coworker_shares WHERE snapshot_id = ? AND status = ?', args: [snapshotId, 'active'] })).rows[0]
            if (!row || String(row.source_revision) !== expectedRevision) refusal(409, 'This share changed or is already withdrawn.')
            await db.execute({ sql: 'UPDATE desktop_coworker_shares SET status = ?, archive_blob = NULL, updated_at = ? WHERE snapshot_id = ?', args: ['revoked', new Date().toISOString(), snapshotId] })
            return record(`revoke:${snapshotId}`, 'revoke', 'revoked', snapshotId, false)
        },
        async markImported(snapshotId: string, targetWorkspaceId: number, requestId: string, importedAgentId: string): Promise<{ importedAgentId: string; status: 'imported' | 'rolled_back' }> {
            await db.execute({ sql: 'INSERT INTO desktop_coworker_share_imports(snapshot_id,target_workspace_id,request_id,imported_agent_id,status,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(snapshot_id,target_workspace_id) DO NOTHING', args: [snapshotId, targetWorkspaceId, requestId, importedAgentId, 'imported', new Date().toISOString()] })
            const row = (await db.execute({ sql: 'SELECT imported_agent_id,status FROM desktop_coworker_share_imports WHERE snapshot_id = ? AND target_workspace_id = ?', args: [snapshotId, targetWorkspaceId] })).rows[0]
            if (!row) refusal(502, 'Import receipt could not be read.')
            await record(requestId, 'import', 'imported', snapshotId, false)
            return { importedAgentId: String(row.imported_agent_id), status: String(row.status) as 'imported' | 'rolled_back' }
        },
        async rollbackImport(snapshotId: string, targetWorkspaceId: number, requestId: string, reason: string): Promise<DesktopCoworkerShareReceipt> {
            await db.execute({ sql: 'UPDATE desktop_coworker_share_imports SET status = ? WHERE snapshot_id = ? AND target_workspace_id = ?', args: ['rolled_back', snapshotId, targetWorkspaceId] })
            return record(requestId, 'import', 'uncertain', snapshotId, true, reason)
        },
        async readImport(snapshotId: string, targetWorkspaceId: number): Promise<{ importedAgentId: string; status: 'imported' | 'rolled_back' } | null> {
            const row = (await db.execute({ sql: 'SELECT imported_agent_id,status FROM desktop_coworker_share_imports WHERE snapshot_id = ? AND target_workspace_id = ?', args: [snapshotId, targetWorkspaceId] })).rows[0]
            return row ? { importedAgentId: String(row.imported_agent_id), status: String(row.status) as 'imported' | 'rolled_back' } : null
        },
        async readManifest(snapshotId: string): Promise<DesktopCoworkerSnapshotManifest | null> {
            const row = (await db.execute({ sql: 'SELECT manifest_json FROM desktop_coworker_shares WHERE snapshot_id = ?', args: [snapshotId] })).rows[0]
            return row ? desktopCoworkerSnapshotManifestSchema.parse(JSON.parse(String(row.manifest_json))) : null
        },
    }
}

export type DesktopCoworkerShareStore = ReturnType<typeof createDesktopCoworkerShareStore>
