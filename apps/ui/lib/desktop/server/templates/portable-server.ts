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
} from '@rerun/contracts'
import { DesktopHttpError } from '../../auth'

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
`

export async function initializeDesktopPortableTemplates(db: Pick<Client, 'executeMultiple'>): Promise<void> {
    await db.executeMultiple(DESKTOP_PORTABLE_TEMPLATE_SCHEMA_SQL)
}

export function createDesktopPortableTemplateServer(deps: PortableServerDeps) {
    if (!deps.readImmutableUpload || !deps.publishDownloadArtifact) {
        // Fail closed for mutating portable ops when root has not wired storage bridges.
    }

    async function row(requestId: string) {
        const result = await deps.db.execute({
            sql: 'SELECT * FROM desktop_portable_template_requests WHERE request_id = ?',
            args: [requestId],
        })
        return result.rows[0] ?? null
    }

    async function insertReceipt(operation: Extract<DesktopPortableOperation, { requestId: string }>, fingerprint: string, payload: unknown) {
        const now = new Date().toISOString()
        const receiptId = randomUUID()
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

    async function save(requestId: string, fields: { status?: string; templateId?: string | null; revision?: string | null; payload?: unknown }) {
        const now = new Date().toISOString()
        await deps.db.execute({
            sql: `UPDATE desktop_portable_template_requests
                  SET status = COALESCE(?, status), template_id = COALESCE(?, template_id), revision = COALESCE(?, revision),
                      payload = COALESCE(?, payload), updated_at = ?
                  WHERE request_id = ?`,
            args: [
                fields.status ?? null,
                fields.templateId ?? null,
                fields.revision ?? null,
                fields.payload === undefined ? null : JSON.stringify(fields.payload),
                now,
                requestId,
            ],
        })
    }

    function engineFailure(error: unknown): never {
        if (error instanceof DesktopHttpError) throw error
        const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: unknown }).status) : 502
        if (status === 400 || status === 404 || status === 409 || status === 413 || status === 503) {
            throw new DesktopHttpError(status as 400 | 404 | 409 | 413 | 503, error instanceof Error ? error.message : 'Portable template request was refused')
        }
        throw new DesktopHttpError(502, 'Could not reach the local portable template engine')
    }

    return {
        async handle(raw: unknown) {
            const operation = desktopPortableOperationSchema.parse(raw)
            if (operation.operation === 'portable-receipt') {
                return this.receipt(operation.requestId)
            }
            const fingerprint = fingerprintOf(operation)
            const existing = await insertReceipt(operation, fingerprint, operation)
            if (String(existing.status) === 'acknowledged') {
                const payload = JSON.parse(String(existing.payload))
                if (operation.operation === 'export') return desktopPortableExportResultSchema.parse(payload)
                if (operation.operation === 'import-package') return desktopPortableImportResultSchema.parse(payload)
                return desktopPortableDeleteResultSchema.parse(payload)
            }
            try {
                if (operation.operation === 'export' && !deps.publishDownloadArtifact) {
                    throw new DesktopHttpError(503, 'Owned download publication is not configured')
                }
                if (operation.operation === 'import-package' && !deps.readImmutableUpload) {
                    throw new DesktopHttpError(503, 'Immutable upload intake is not configured')
                }
                const path = operation.operation === 'import-package' ? '/desktop/templates/import-package'
                    : operation.operation === 'export' ? '/desktop/templates/export'
                        : '/desktop/templates/delete'
                const result = await deps.engine.post(path, operation, deps.signal)
                const parsed = operation.operation === 'export'
                    ? desktopPortableExportResultSchema.parse(result)
                    : operation.operation === 'import-package'
                        ? desktopPortableImportResultSchema.parse(result)
                        : desktopPortableDeleteResultSchema.parse(result)
                await save(operation.requestId, {
                    status: parsed.status === 'uncertain' ? 'uncertain' : 'acknowledged',
                    templateId: 'templateId' in parsed ? parsed.templateId : null,
                    revision: 'revision' in parsed ? parsed.revision : null,
                    payload: parsed,
                })
                if (parsed.status === 'exported') {
                    await deps.db.execute({
                        sql: `INSERT OR REPLACE INTO desktop_portable_template_artifacts
                              (artifact_id, template_id, revision, file_name, content_digest, bytes, created_at)
                              VALUES (?,?,?,?,?,?,?)`,
                        args: [parsed.artifactId, parsed.templateId, parsed.revision, parsed.fileName, parsed.contentDigest, parsed.bytes, new Date().toISOString()],
                    })
                }
                return parsed
            } catch (error) {
                await save(operation.requestId, {
                    status: 'uncertain',
                    payload: {
                        status: 'uncertain',
                        requestId: operation.requestId,
                        receiptId: String(existing.receipt_id),
                        recoverable: true,
                        reason: error instanceof Error ? error.message.slice(0, 400) : 'Portable operation did not finish',
                    },
                })
                engineFailure(error)
            }
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
                recoverable: String(existing.status) === 'uncertain',
            })
        },

        async pickUpload() {
            if (!deps.pickImmutableUpload) throw new DesktopHttpError(503, 'Native immutable file picker is not configured')
            return deps.pickImmutableUpload()
        },

        async openDownload(artifactId: string) {
            if (!deps.openOwnedDownload) throw new DesktopHttpError(503, 'Owned download opener is not configured')
            if (!/^[a-f0-9]{32}$/.test(artifactId)) throw new DesktopHttpError(400, 'Invalid download artifact')
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
