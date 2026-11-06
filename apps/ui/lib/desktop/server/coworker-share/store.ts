import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row, Transaction } from '@libsql/client'
import { desktopCoworkerShareReceiptSchema, desktopCoworkerSnapshotManifestSchema, type DesktopCoworkerShareInclude, type DesktopCoworkerShareReceipt, type DesktopCoworkerShareImportInput, type DesktopCoworkerShareExportInput } from '@rerun/contracts'
import type { DesktopCoworkerSnapshot } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { portableContentDigest } from '../../../../../engine/src/desktop/templates/portable-package'
import { DesktopHttpError } from '../auth'

function refuse(message: string): never { throw new DesktopHttpError(409, message) }
export function shareFingerprint(value: unknown): string {
    const canonical = (input: unknown): string => Array.isArray(input) ? `[${input.map(canonical).join(',')}]` : input && typeof input === 'object' ? `{${Object.entries(input).sort(([a],[b]) => a.localeCompare(b)).map(([key,child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}` : JSON.stringify(input) ?? 'null'
    return createHash('sha256').update(canonical(value)).digest('hex')
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Reader = Pick<Client, 'execute'>
const QUEUE = Symbol.for('rerun.desktop.coworker-share.sqlite.v1')
const queue = () => ((globalThis as unknown as Record<symbol, { tail: Promise<unknown> }>)[QUEUE] ??= { tail: Promise.resolve() })
function receiptOf(row: Row): DesktopCoworkerShareReceipt {
    return desktopCoworkerShareReceiptSchema.parse({ requestId: String(row.request_id), operation: String(row.operation), status: String(row.status), snapshotId: String(row.snapshot_id), recoverable: Number(row.recoverable) === 1, ...(row.reason == null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at) })
}

export function createDesktopCoworkerShareStore(db: Client) {
    const write = <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
        const state = queue(), result = state.tail.catch(() => {}).then(async () => {
            const tx = await db.transaction('write')
            try { const value = await work(tx); await tx.commit(); return value }
            catch (error) { await tx.rollback().catch(() => {}); throw error }
            finally { tx.close() }
        })
        state.tail = result.catch(() => {}); return result
    }
    const receipt = async (requestId: string, reader: Reader = db): Promise<DesktopCoworkerShareReceipt | null> => {
        const row = (await reader.execute({ sql: 'SELECT * FROM desktop_coworker_share_receipts WHERE request_id=?', args: [requestId] })).rows[0]
        return row ? receiptOf(row) : null
    }
    const record = async (reader: Reader, requestId: string, operation: DesktopCoworkerShareReceipt['operation'], status: DesktopCoworkerShareReceipt['status'], snapshotId: string, recoverable = false, reason?: string) => {
        const prior = await receipt(requestId, reader)
        if (prior && (prior.operation !== operation || prior.snapshotId !== snapshotId)) refuse('This request already belongs to another share operation.')
        await reader.execute({ sql: `INSERT INTO desktop_coworker_share_receipts(request_id,operation,snapshot_id,status,recoverable,reason,created_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(request_id) DO UPDATE SET status=excluded.status,recoverable=excluded.recoverable,reason=excluded.reason WHERE desktop_coworker_share_receipts.status='uncertain'`, args: [requestId,operation,snapshotId,status,recoverable ? 1 : 0,reason ?? null,new Date().toISOString()] })
        return (await receipt(requestId, reader))!
    }
    const metadata = async (snapshotId: string, reader: Reader = db) => {
        const row = (await reader.execute({ sql: 'SELECT * FROM desktop_coworker_shares WHERE snapshot_id=?', args: [snapshotId] })).rows[0]
        if (!row) return null
        const manifest = desktopCoworkerSnapshotManifestSchema.parse(JSON.parse(String(row.manifest_json)))
        const { contentDigest, ...body } = manifest
        if (manifest.packageKey !== snapshotId || portableContentDigest(body) !== contentDigest) throw new DesktopHttpError(503, 'The saved share identity could not be confirmed.')
        return { row, manifest }
    }
    const archive = async (snapshotId: string, reader: Reader = db) => {
        const found = await metadata(snapshotId, reader)
        if (!found || found.row.status !== 'active' || !found.row.archive_blob) refuse('This local share is no longer available.')
        if (!(found.row.archive_blob instanceof ArrayBuffer)) throw new DesktopHttpError(503,'The saved share bytes are invalid.')
        const bytes = Buffer.from(found.row.archive_blob), digest = String(found.row.archive_sha256)
        if (bytes.length !== Number(found.row.archive_bytes) || hash(bytes) !== digest) throw new DesktopHttpError(503, 'The saved share bytes could not be confirmed.')
        return { bytes, sha256: digest }
    }
    const create = async (reader: Reader, snapshot: DesktopCoworkerSnapshot, sourceAgentId?: string, include?: DesktopCoworkerShareInclude, sourceRevision?: string) => {
        const prior = await metadata(snapshot.manifest.packageKey, reader)
        if (prior) {
            if (prior.row.status !== 'active' || prior.manifest.contentDigest !== snapshot.manifest.contentDigest || String(prior.row.archive_sha256) !== snapshot.archiveSha256) refuse('A different or withdrawn snapshot already uses this identity.')
            await archive(snapshot.manifest.packageKey, reader)
            return { reused: true }
        }
        if (hash(snapshot.archiveBytes) !== snapshot.archiveSha256) throw new DesktopHttpError(503, 'Share archive digest mismatch.')
        const now = new Date().toISOString()
        await reader.execute({ sql: 'INSERT INTO desktop_coworker_shares(snapshot_id,source_agent_id,source_revision,include_json,manifest_json,archive_blob,archive_sha256,archive_bytes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', args: [snapshot.manifest.packageKey,sourceAgentId ?? snapshot.manifest.coworkers[0]!.name,sourceRevision ?? snapshot.manifest.contentDigest,JSON.stringify(include ?? {}),JSON.stringify(snapshot.manifest),snapshot.archiveBytes,snapshot.archiveSha256,snapshot.archiveBytes.length,'active',now,now] })
        return { reused: false }
    }
    const operation = async (reader: Reader, requestId: string, kind: string, fingerprint: string, snapshotId: string) => {
        const prior = (await reader.execute({ sql: 'SELECT * FROM desktop_coworker_share_operations WHERE request_id=?', args: [requestId] })).rows[0]
        if (prior && (prior.operation !== kind || prior.fingerprint !== fingerprint || prior.snapshot_id !== snapshotId)) refuse('This request was already used for another share change.')
        if (prior) return prior
        const oldReceipt = await receipt(requestId, reader)
        if (oldReceipt && (oldReceipt.operation !== kind || oldReceipt.snapshotId !== snapshotId)) refuse('This request was already used for another operation.')
        await reader.execute({ sql: "INSERT INTO desktop_coworker_share_operations(request_id,operation,fingerprint,snapshot_id,state,created_at) VALUES(?,?,?,?,'pending',?)", args: [requestId,kind,fingerprint,snapshotId,new Date().toISOString()] })
        return null
    }
    const readImport = async (snapshotId: string, targetWorkspaceId: number, reader: Reader = db) => {
        const row = (await reader.execute({ sql: 'SELECT * FROM desktop_coworker_share_imports WHERE snapshot_id=? AND target_workspace_id=?', args: [snapshotId,targetWorkspaceId] })).rows[0]
        if (!row) return null
        const body = { requestId: String(row.request_id),snapshotId,expectedDigest: String(row.expected_digest),targetWorkspaceId }
        const expected = shareFingerprint(['import',body])
        const operation = (await reader.execute({ sql: 'SELECT operation,snapshot_id,fingerprint FROM desktop_coworker_share_operations WHERE request_id=?',args: [body.requestId] })).rows[0]
        if (row.fingerprint !== expected || !operation || operation.operation !== 'import' || operation.snapshot_id !== snapshotId || operation.fingerprint !== expected || !['pending','imported','uncertain','rolled_back'].includes(String(row.status)) || row.status === 'imported' && !row.imported_agent_id) throw new DesktopHttpError(503,'The saved import identity could not be confirmed.')
        return { requestId: body.requestId, fingerprint: expected, expectedDigest: body.expectedDigest, importedAgentId: String(row.imported_agent_id), status: String(row.status) as 'pending' | 'imported' | 'uncertain' | 'rolled_back' }
    }
    return {
        db, coordinationKey: db, receipt, metadata, readImport,
        create: (snapshot: DesktopCoworkerSnapshot, sourceAgentId?: string, include?: DesktopCoworkerShareInclude, sourceRevision?: string) => write(tx => create(tx,snapshot,sourceAgentId,include,sourceRevision)),
        readArchive: archive,
        async readManifest(snapshotId: string) { return (await metadata(snapshotId))?.manifest ?? null },
        recordExport: (requestId: string, snapshotId: string) => write(tx => record(tx,requestId,'export','created',snapshotId)),
        publishExport(input: DesktopCoworkerShareExportInput, snapshot: DesktopCoworkerSnapshot) {
            return write(async tx => {
                const fingerprint = shareFingerprint(['export',input])
                await operation(tx,input.requestId,'export',fingerprint,snapshot.manifest.packageKey)
                const result = await create(tx,snapshot,input.agentId,input.include,input.sourceRevision)
                await record(tx,input.requestId,'export','created',snapshot.manifest.packageKey)
                await tx.execute({ sql: "UPDATE desktop_coworker_share_operations SET state='complete' WHERE request_id=? AND fingerprint=?", args: [input.requestId,fingerprint] })
                return result
            })
        },
        reserveImport(input: DesktopCoworkerShareImportInput) {
            return write(async tx => {
                const fingerprint = shareFingerprint(['import',input]), previous = await readImport(input.snapshotId,input.targetWorkspaceId,tx)
                await operation(tx,input.requestId,'import',fingerprint,input.snapshotId)
                if (previous) {
                    if (previous.expectedDigest !== input.expectedDigest || previous.requestId === input.requestId && previous.fingerprint !== fingerprint) refuse('The reserved import identity changed.')
                    return { ...previous, fresh: false }
                }
                await tx.execute({ sql: "INSERT INTO desktop_coworker_share_imports(snapshot_id,target_workspace_id,request_id,imported_agent_id,status,fingerprint,expected_digest,created_at) VALUES(?,?,?,'','pending',?,?,?)", args: [input.snapshotId,input.targetWorkspaceId,input.requestId,fingerprint,input.expectedDigest,new Date().toISOString()] })
                return { requestId: input.requestId, fingerprint, expectedDigest: input.expectedDigest, importedAgentId: '', status: 'pending' as const, fresh: true }
            })
        },
        settleImport(input: DesktopCoworkerShareImportInput, importedAgentId: string) {
            return write(async tx => {
                const previous = await readImport(input.snapshotId,input.targetWorkspaceId,tx)
                if (!previous || previous.requestId !== input.requestId || previous.fingerprint !== shareFingerprint(['import',input])) refuse('Import reservation changed.')
                if (previous.status === 'imported') {
                    if (previous.importedAgentId !== importedAgentId) refuse('Import result identity changed.')
                    return previous
                }
                const written = await tx.execute({ sql: "UPDATE desktop_coworker_share_imports SET imported_agent_id=?,status='imported' WHERE snapshot_id=? AND target_workspace_id=? AND request_id=? AND fingerprint=? AND status IN ('pending','uncertain')", args: [importedAgentId,input.snapshotId,input.targetWorkspaceId,input.requestId,previous.fingerprint] })
                if (written.rowsAffected !== 1) refuse('Import receipt was not saved.')
                await record(tx,input.requestId,'import','imported',input.snapshotId)
                await tx.execute({ sql: "UPDATE desktop_coworker_share_operations SET state='complete',result=? WHERE request_id=? AND fingerprint=?", args: [JSON.stringify({ importedAgentId }),input.requestId,previous.fingerprint] })
                return { ...previous, importedAgentId, status: 'imported' as const }
            })
        },
        uncertainImport(input: DesktopCoworkerShareImportInput) {
            return write(async tx => {
                const previous = await readImport(input.snapshotId,input.targetWorkspaceId,tx)
                if (!previous || previous.requestId !== input.requestId || previous.fingerprint !== shareFingerprint(['import',input])) refuse('Import reservation changed.')
                if (previous.status === 'imported') return previous
                await tx.execute({ sql: "UPDATE desktop_coworker_share_imports SET status='uncertain' WHERE snapshot_id=? AND target_workspace_id=? AND request_id=? AND fingerprint=? AND status='pending'", args: [input.snapshotId,input.targetWorkspaceId,input.requestId,previous.fingerprint] })
                await record(tx,input.requestId,'import','uncertain',input.snapshotId,true,'Import acknowledgement is unknown. Retry the original request.')
                return { ...previous, status: 'uncertain' as const }
            })
        },
        revoke(snapshotId: string, expectedRevision: string, requestId = `revoke:${snapshotId}`) {
            return write(async tx => {
                const fingerprint = shareFingerprint(['revoke',snapshotId,expectedRevision,requestId])
                await operation(tx,requestId,'revoke',fingerprint,snapshotId)
                const prior = await receipt(requestId,tx)
                if (prior?.status === 'revoked') return prior
                const found = await metadata(snapshotId,tx)
                if (!found || found.row.source_revision !== expectedRevision) refuse('This share revision changed.')
                await tx.execute({ sql: "UPDATE desktop_coworker_shares SET status='revoked',archive_blob=NULL,updated_at=? WHERE snapshot_id=? AND source_revision=?", args: [new Date().toISOString(),snapshotId,expectedRevision] })
                const result = await record(tx,requestId,'revoke','revoked',snapshotId)
                await tx.execute({ sql: "UPDATE desktop_coworker_share_operations SET state='complete' WHERE request_id=? AND fingerprint=?", args: [requestId,fingerprint] })
                return result
            })
        },
    }
}
export type DesktopCoworkerShareStore = ReturnType<typeof createDesktopCoworkerShareStore>
