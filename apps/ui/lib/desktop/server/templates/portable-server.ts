import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import {
    desktopPortableDeleteResultSchema,
    desktopPortableExportResultSchema,
    desktopPortableImportResultSchema,
    desktopPortableOperationSchema,
    desktopPortableReceiptSchema,
    type DesktopPortableOperation,
    type DesktopPortableExportResult,
    type DesktopPortableImportResult,
    type DesktopPortableDeleteResult,
} from '@rerun/contracts'
import { DesktopHttpError } from '../auth'

export type PortableEngineClient = {
    post: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>
    get: (path: string, signal?: AbortSignal) => Promise<unknown>
}

export type PortableServerDeps = {
    db: Client
    engine: PortableEngineClient
    // Root-owned native pickers/downloads. Never accept renderer absolute paths.
    publishDownloadArtifact?: (bytes: Buffer, fileName: string) => Promise<{ artifactId: string }>
    readImmutableUpload?: (uploadId: string) => Promise<Buffer>
    pickImmutableUpload?: () => Promise<{ uploadId: string; fileName: string; bytes: number }>
    openOwnedDownload?: (artifactId: string) => Promise<void>
    signal?: AbortSignal
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
        entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
    }
    return JSON.stringify(value) ?? 'null'
}

const fingerprintOf = (operation: DesktopPortableOperation) => createHash('sha256').update(canonicalJson(operation)).digest('hex')

export const DESKTOP_PORTABLE_TEMPLATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_portable_template_requests (
    request_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE,
    operation TEXT NOT NULL,
    template_id TEXT,
    revision TEXT,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_portable_template_artifacts (
    artifact_id TEXT PRIMARY KEY,
    template_id TEXT,
    revision TEXT,
    file_name TEXT NOT NULL,
    content_digest TEXT,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_portable_template_intents (
    scope TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    operation TEXT NOT NULL
);
`

export async function initializeDesktopPortableTemplates(db: Pick<Client, 'executeMultiple'>): Promise<void> {
    await db.executeMultiple(DESKTOP_PORTABLE_TEMPLATE_SCHEMA_SQL)
}

type Mutation = Exclude<DesktopPortableOperation, { operation: 'portable-receipt' }>
type Result = DesktopPortableExportResult | DesktopPortableImportResult | DesktopPortableDeleteResult
const activeRequests = new WeakMap<Client, Map<string, { fingerprint: string; work: Promise<Result> }>>()
const liveClaims = new Map<string, Promise<Result>>()
function processIsAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

export function createDesktopPortableTemplateServer(deps: PortableServerDeps) {
    const active = activeRequests.get(deps.db) ?? new Map<string, { fingerprint: string; work: Promise<Result> }>()
    activeRequests.set(deps.db, active)

    async function row(requestId: string) {
        const result = await deps.db.execute({
            sql: 'SELECT * FROM desktop_portable_template_requests WHERE request_id = ?',
            args: [requestId],
        })
        return result.rows[0] ?? null
    }

    async function insertReceipt(operation: Extract<DesktopPortableOperation, { requestId: string }>, fingerprint: string, payload: unknown) {
        const now = new Date().toISOString()
        const receiptId = operation.requestId
        try {
            await deps.db.execute({
                sql: `INSERT INTO desktop_portable_template_requests
                      (request_id, receipt_id, operation, template_id, revision, fingerprint, status, payload, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?)`,
                args: [
                    operation.requestId, receiptId, operation.operation,
                    'templateId' in operation ? operation.templateId : null,
                    'revision' in operation ? operation.revision : null,
                    fingerprint, 'accepted', JSON.stringify(payload), now, now,
                ],
            })
        } catch (error) {
            const existing = await row(operation.requestId)
            if (!existing) throw error
            if (String(existing.operation) !== operation.operation || String(existing.fingerprint) !== fingerprint) {
                throw new DesktopHttpError(409, 'This portable template request already belongs to another change')
            }
            return existing
        }
        return (await row(operation.requestId))!
    }

    function parseResult(operation: Mutation, value: unknown): Result {
        const parsed = operation.operation === 'export' ? desktopPortableExportResultSchema.parse(value)
            : operation.operation === 'import-package' ? desktopPortableImportResultSchema.parse(value)
                : desktopPortableDeleteResultSchema.parse(value)
        if (parsed.requestId !== operation.requestId || parsed.receiptId !== operation.requestId) throw new DesktopHttpError(502, 'Portable response belongs to another request')
        if ('templateId' in operation && 'templateId' in parsed && (parsed.templateId !== operation.templateId || parsed.revision !== operation.revision)) throw new DesktopHttpError(502, 'Portable response belongs to another revision')
        if (operation.operation === 'import-package' && parsed.status === 'imported' && parsed.provenance.uploadId !== operation.uploadId) throw new DesktopHttpError(502, 'Portable response belongs to another upload')
        return parsed
    }

    const uncertain = (requestId: string, reason = 'Portable acknowledgement is unknown. Retry this same attempt.'): Result => ({ status: 'uncertain', requestId, receiptId: requestId, recoverable: true, reason })

    async function execute(operation: Mutation, fingerprint: string, claimId: string): Promise<Result> {
        const existing = await insertReceipt(operation, fingerprint, operation)
        if (String(existing.status) === 'acknowledged') return parseResult(operation, JSON.parse(String(existing.payload)))
        if (String(existing.status) === 'executing') {
            const priorClaim = z.object({ claimId: z.uuid(), pid: z.number().int().positive() }).safeParse(JSON.parse(String(existing.payload)))
            if (!priorClaim.success) return uncertain(operation.requestId, 'This attempt needs recovery before another change can start.')
            const running = liveClaims.get(priorClaim.data.claimId)
            if (running) return running
            if (processIsAlive(priorClaim.data.pid)) return uncertain(operation.requestId, 'This portable attempt is still finishing. Retry the same attempt to recover its result.')
        }
        const claim = JSON.stringify({ operation, claimId, pid: process.pid })
        const claimed = await deps.db.execute({
            sql: `UPDATE desktop_portable_template_requests SET status = 'executing', payload = ?, updated_at = ?
                  WHERE request_id = ? AND fingerprint = ? AND status = ? AND payload = ? AND updated_at = ?`,
            args: [claim, new Date().toISOString(), operation.requestId, fingerprint, String(existing.status), String(existing.payload), String(existing.updated_at)],
        })
        if (claimed.rowsAffected !== 1) {
            const current = await row(operation.requestId)
            return current?.status === 'acknowledged' ? parseResult(operation, JSON.parse(String(current.payload))) : uncertain(operation.requestId, 'This portable attempt is already finishing. Retry the same attempt to recover its result.')
        }
        try {
            deps.signal?.throwIfAborted()
            const path = operation.operation === 'import-package' ? '/desktop/templates/import-package'
                : operation.operation === 'export' ? '/desktop/templates/export' : '/desktop/templates/delete'
            const parsed = parseResult(operation, await deps.engine.post(path, operation, deps.signal))
            const tx = await deps.db.transaction('write')
            try {
                const current = (await tx.execute({ sql: 'SELECT status, payload FROM desktop_portable_template_requests WHERE request_id = ?', args: [operation.requestId] })).rows[0]
                if (current?.status === 'acknowledged') return parseResult(operation, JSON.parse(String(current.payload)))
                if (current?.status !== 'executing' || current.payload !== claim) throw new DesktopHttpError(409, 'Portable recovery is owned by another attempt')
                if (parsed.status === 'exported') {
                    await tx.execute({
                        sql: `INSERT INTO desktop_portable_template_artifacts
                              (artifact_id, template_id, revision, file_name, content_digest, bytes, created_at)
                              VALUES (?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO NOTHING`,
                        args: [parsed.artifactId, parsed.templateId, parsed.revision, parsed.fileName, parsed.contentDigest, parsed.bytes, new Date().toISOString()],
                    })
                    const artifact = (await tx.execute({ sql: 'SELECT * FROM desktop_portable_template_artifacts WHERE artifact_id = ?', args: [parsed.artifactId] })).rows[0]
                    if (!artifact || artifact.template_id !== parsed.templateId || artifact.revision !== parsed.revision || artifact.file_name !== parsed.fileName || artifact.content_digest !== parsed.contentDigest || Number(artifact.bytes) !== parsed.bytes) throw new DesktopHttpError(409, 'Download identity is already owned by another export')
                }
                await tx.execute({
                    sql: `UPDATE desktop_portable_template_requests SET status = ?, template_id = COALESCE(?, template_id), revision = COALESCE(?, revision), payload = ?, updated_at = ?
                          WHERE request_id = ? AND status = 'executing' AND payload = ?`,
                    args: [parsed.status === 'uncertain' ? 'uncertain' : 'acknowledged', 'templateId' in parsed ? parsed.templateId : null, 'revision' in parsed ? parsed.revision : null, JSON.stringify(parsed), new Date().toISOString(), operation.requestId, claim],
                })
                await tx.commit()
                return parsed
            } catch (error) { await tx.rollback().catch(() => undefined); throw error }
            finally { tx.close() }
        } catch (error) {
            const rejectedStatus = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
            if (rejectedStatus === 400 || rejectedStatus === 413) {
                await deps.db.batch([
                    { sql: `UPDATE desktop_portable_template_requests SET status = 'refused', updated_at = ? WHERE request_id = ? AND status = 'executing' AND payload = ?`, args: [new Date().toISOString(), operation.requestId, claim] },
                    { sql: `DELETE FROM desktop_portable_template_intents WHERE request_id = ? AND EXISTS (SELECT 1 FROM desktop_portable_template_requests WHERE request_id = ? AND status = 'refused')`, args: [operation.requestId, operation.requestId] },
                ], 'write')
                throw new DesktopHttpError(rejectedStatus, 'This package could not be imported. Check the file and try again.')
            }
            const pending = uncertain(operation.requestId)
            await deps.db.execute({
                sql: `UPDATE desktop_portable_template_requests SET status = 'uncertain', payload = ?, updated_at = ? WHERE request_id = ? AND status = 'executing' AND payload = ?`,
                args: [JSON.stringify(pending), new Date().toISOString(), operation.requestId, claim],
            }).catch(() => undefined)
            const current = await row(operation.requestId).catch(() => null)
            return current?.status === 'acknowledged' ? parseResult(operation, JSON.parse(String(current.payload))) : pending
        }
    }

    return {
        async prepare(raw: unknown) {
            const input = z.strictObject({ operation: desktopPortableOperationSchema }).safeParse(raw)
            if (!input.success || input.data.operation.operation === 'portable-receipt') throw new DesktopHttpError(400, 'Invalid portable template attempt')
            const operation = input.data.operation
            const scope = operation.operation === 'import-package' ? 'import-package' : `${operation.operation}:${operation.templateId}:${operation.revision}`
            const tx = await deps.db.transaction('write')
            try {
                const previous = (await tx.execute({ sql: 'SELECT request_id, operation FROM desktop_portable_template_intents WHERE scope = ?', args: [scope] })).rows[0]
                if (previous) {
                    const stored = desktopPortableOperationSchema.parse(JSON.parse(String(previous.operation)))
                    const receipt = (await tx.execute({ sql: 'SELECT status FROM desktop_portable_template_requests WHERE request_id = ?', args: [String(previous.request_id)] })).rows[0]
                    if (!receipt || receipt.status !== 'refused') {
                        if (operation.operation === 'import-package' && stored.operation === 'import-package' && (operation.uploadId !== stored.uploadId || operation.title !== stored.title)) throw new DesktopHttpError(409, 'An earlier import needs recovery before importing a different package')
                        return stored
                    }
                    await tx.execute({ sql: 'DELETE FROM desktop_portable_template_intents WHERE scope = ?', args: [scope] })
                }
                await tx.execute({ sql: 'INSERT INTO desktop_portable_template_intents(scope, request_id, operation) VALUES(?,?,?)', args: [scope, operation.requestId, JSON.stringify(operation)] })
                await tx.commit()
                return operation
            } catch (error) { await tx.rollback().catch(() => undefined); throw error }
            finally { tx.close() }
        },

        async pendingImport() {
            const pending = (await deps.db.execute({ sql: "SELECT operation FROM desktop_portable_template_intents WHERE scope = 'import-package'", args: [] })).rows[0]
            if (!pending) return null
            const operation = desktopPortableOperationSchema.parse(JSON.parse(String(pending.operation)))
            if (operation.operation !== 'import-package') throw new DesktopHttpError(409, 'Invalid pending import')
            return operation
        },

        async acknowledge(requestId: unknown) {
            if (!z.uuid().safeParse(requestId).success) throw new DesktopHttpError(400, 'Invalid portable request')
            await deps.db.execute({
                sql: `DELETE FROM desktop_portable_template_intents WHERE request_id = ? AND EXISTS
                      (SELECT 1 FROM desktop_portable_template_requests WHERE request_id = ? AND status = 'acknowledged')`,
                args: [String(requestId), String(requestId)],
            })
            return { ok: true as const }
        },

        async handle(raw: unknown) {
            const operation = desktopPortableOperationSchema.parse(raw)
            if (operation.operation === 'portable-receipt') return this.receipt(operation.requestId)
            const fingerprint = fingerprintOf(operation)
            const running = active.get(operation.requestId)
            if (running) {
                if (running.fingerprint !== fingerprint) throw new DesktopHttpError(409, 'This portable request already belongs to another change')
                return running.work
            }
            const claimId = randomUUID()
            const work = Promise.resolve().then(() => execute(operation, fingerprint, claimId))
            active.set(operation.requestId, { fingerprint, work })
            liveClaims.set(claimId, work)
            const done = () => { active.delete(operation.requestId); liveClaims.delete(claimId) }
            void work.then(done, done)
            return work
        },

        async receipt(requestId: string) {
            if (!z.uuid().safeParse(requestId).success) throw new DesktopHttpError(400, 'Invalid portable request')
            const existing = await row(requestId)
            if (!existing) throw new DesktopHttpError(404, 'Portable template receipt not found')
            const payload = JSON.parse(String(existing.payload)) as Record<string, unknown>
            return desktopPortableReceiptSchema.parse({
                requestId: String(existing.request_id),
                receiptId: String(existing.receipt_id),
                operation: String(existing.operation),
                status: String(existing.status),
                templateId: existing.template_id == null ? null : String(existing.template_id),
                revision: existing.revision == null ? null : String(existing.revision),
                artifactId: typeof payload.artifactId === 'string' ? payload.artifactId : null,
                recoverable: String(existing.status) !== 'acknowledged',
            })
        },

        async pickUpload() {
            if (!deps.pickImmutableUpload) throw new DesktopHttpError(503, 'Native immutable file picker is not configured')
            return deps.pickImmutableUpload()
        },

        async openDownload(artifactId: string) {
            if (!deps.openOwnedDownload) throw new DesktopHttpError(503, 'Owned download opener is not configured')
            if (!/^[a-f0-9]{32}$/.test(artifactId)) throw new DesktopHttpError(400, 'Invalid download artifact')
            const owned = await deps.db.execute({ sql: 'SELECT artifact_id FROM desktop_portable_template_artifacts WHERE artifact_id = ?', args: [artifactId] })
            if (!owned.rows.length) throw new DesktopHttpError(404, 'Download artifact not found')
            await deps.openOwnedDownload(artifactId)
            return { ok: true as const }
        },
    }
}

export type DesktopPortableTemplateServer = ReturnType<typeof createDesktopPortableTemplateServer>

export const portableUiRouteFragments = {
    postIntent: '/api/desktop/templates/portable/intent',
    postOperation: '/api/desktop/templates/portable',
    getReceipt: '/api/desktop/templates/portable/receipt',
    postPickUpload: '/api/desktop/templates/portable/pick-upload',
    postOpenDownload: '/api/desktop/templates/portable/open-download',
} as const
