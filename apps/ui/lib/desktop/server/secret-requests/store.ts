import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import {
    DESKTOP_SECRET_TOTAL_MAX_BYTES,
    DESKTOP_SECRET_VALUE_MAX_BYTES,
    desktopSecretRequestInputSchema,
    serializeDesktopSecretReceiptSummary,
    type DesktopSecretRequestDecision,
    type DesktopSecretRequestField,
    type DesktopSecretRequestInput,
    type DesktopSecretRequestReceipt,
    type DesktopSecretRequestSource,
    type DesktopSecretRequestView,
} from '../../../../../../packages/contracts/src/desktop-secret-requests'
import { DesktopHttpError } from '../auth'
import type { DesktopSecretCrypto } from './crypto'

export type DesktopSecretRequestAuthority = { check: () => void }
type Query = Pick<Client, 'execute'>
type RequestRow = {
    requestId: string
    source: DesktopSecretRequestSource
    input: DesktopSecretRequestInput
    revision: string
    status: DesktopSecretRequestView['status']
    createdAt: string
    updatedAt: string
}

const lockKey = Symbol.for('rerun.desktop.secret-request-writes.v1')
const lockHost = globalThis as typeof globalThis & { [lockKey]?: Map<string, Promise<void>> }
const locks = lockHost[lockKey] ??= new Map<string, Promise<void>>()

function withRequestLock<T>(requestId: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(requestId) ?? Promise.resolve()
    const result = previous.then(action, action)
    const settled = result.then(() => undefined, () => undefined)
    locks.set(requestId, settled)
    void settled.then(() => { if (locks.get(requestId) === settled) locks.delete(requestId) })
    return result
}

function refusal(status: number, message: string): never {
    throw new DesktopHttpError(status, message)
}

function identity(source: DesktopSecretRequestSource): string {
    return createHash('sha256').update(JSON.stringify(['desktop-secret-request-v1', source])).digest('hex')
}

function sameSource(a: DesktopSecretRequestSource, b: DesktopSecretRequestSource): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

function requestOf(row: Row): RequestRow {
    return {
        requestId: String(row.request_id),
        source: {
            agentId: String(row.agent_id), sessionId: String(row.session_id), runId: String(row.run_id),
            sourceMessageId: String(row.source_message_id), toolCallId: String(row.tool_call_id), fingerprint: String(row.fingerprint),
        },
        input: desktopSecretRequestInputSchema.parse({ ...JSON.parse(String(row.ordered_input)), ...(row.reason == null ? {} : { reason: String(row.reason) }) }),
        revision: String(row.revision), status: String(row.status) as RequestRow['status'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
}

function receiptOf(row: Row): DesktopSecretRequestReceipt & { requestId: string } {
    return {
        requestId: String(row.request_id), attemptId: String(row.attempt_id), decision: String(row.decision) as DesktopSecretRequestReceipt['decision'],
        providedKeys: JSON.parse(String(row.provided_keys)), skippedKeys: JSON.parse(String(row.skipped_keys)), summary: String(row.summary_text),
        continuationRequestId: String(row.continuation_request_id), accepted: Number(row.accepted) === 1, createdAt: String(row.created_at),
    }
}

async function requestById(db: Query, requestId: string): Promise<RequestRow | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_secret_requests WHERE request_id = ?', args: [requestId] })
    return result.rows[0] ? requestOf(result.rows[0]) : null
}

async function receiptById(db: Query, requestId: string): Promise<(DesktopSecretRequestReceipt & { requestId: string }) | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_secret_receipts WHERE request_id = ?', args: [requestId] })
    return result.rows[0] ? receiptOf(result.rows[0]) : null
}

async function existingNames(db: Query, agentId: string): Promise<string[]> {
    const result = await db.execute({ sql: 'SELECT key FROM desktop_secret_credentials WHERE agent_id = ? ORDER BY key LIMIT 129', args: [agentId] })
    if (result.rows.length > 128) refusal(502, 'Coworker credential names could not be read.')
    return result.rows.map(row => String(row.key))
}

async function viewOf(db: Query, request: RequestRow): Promise<DesktopSecretRequestView> {
    const [names, receipt, attempt] = await Promise.all([
        existingNames(db, request.source.agentId),
        receiptById(db, request.requestId),
        db.execute({ sql: "SELECT attempt_id,operation,state FROM desktop_secret_attempts WHERE request_id = ? AND state != 'refused'", args: [request.requestId] }),
    ])
    const present = new Set(names)
    return {
        requestId: request.requestId, revision: request.revision, source: request.source,
        ...(request.input.reason !== undefined ? { reason: request.input.reason } : {}),
        fields: request.input.fields.map(field => ({ ...field, existing: present.has(field.key) })),
        status: request.status,
        ...(request.status !== 'accepted' && attempt.rows[0] ? { pendingAttempt: { attemptId: String(attempt.rows[0].attempt_id), operation: String(attempt.rows[0].operation) as DesktopSecretRequestDecision['operation'], state: String(attempt.rows[0].state) as 'staged' | 'sealed' } } : {}),
        ...(receipt ? { receipt: { attemptId: receipt.attemptId, decision: receipt.decision, providedKeys: receipt.providedKeys, skippedKeys: receipt.skippedKeys, summary: receipt.summary, continuationRequestId: receipt.continuationRequestId, accepted: receipt.accepted, createdAt: receipt.createdAt } } : {}),
        createdAt: request.createdAt, updatedAt: request.updatedAt,
    }
}

function validateValues(input: DesktopSecretRequestDecision, fields: readonly DesktopSecretRequestField[]): { providedKeys: string[]; entries: [string, string][] } {
    if (input.operation !== 'save') {
        if (input.values !== undefined) refusal(400, 'Skip and Dismiss do not accept credential values.')
        return { providedKeys: [], entries: [] }
    }
    if (!input.values || typeof input.values !== 'object') refusal(400, 'Enter at least one requested credential.')
    const allowed = new Set(fields.map(field => field.key))
    const entries: [string, string][] = []
    let total = 0
    for (const [key, value] of Object.entries(input.values)) {
        if (!allowed.has(key) || typeof value !== 'string') refusal(400, 'A submitted credential does not belong to this request.')
        const bytes = Buffer.byteLength(value, 'utf8')
        if (bytes > DESKTOP_SECRET_VALUE_MAX_BYTES) refusal(413, 'A credential value is too large.')
        total += bytes
        if (bytes > 0) entries.push([key, value])
    }
    if (total > DESKTOP_SECRET_TOTAL_MAX_BYTES) refusal(413, 'The submitted credentials are too large together.')
    if (!entries.length) refusal(400, 'Enter at least one requested credential.')
    const provided = new Set(entries.map(([key]) => key))
    return { providedKeys: fields.filter(field => provided.has(field.key)).map(field => field.key), entries }
}

export function createDesktopSecretRequestStore(db: Client, crypto: DesktopSecretCrypto) {
    async function bodyFingerprint(input: DesktopSecretRequestDecision, fields: readonly DesktopSecretRequestField[]): Promise<{ fingerprint: string; providedKeys: string[]; entries: [string, string][] }> {
        const validated = validateValues(input, fields)
        const body = new TextEncoder().encode(JSON.stringify({
            operation: input.operation, expectedRevision: input.expectedRevision, source: input.source,
            values: validated.entries,
        }))
        return { ...validated, fingerprint: await crypto.fingerprint({ agentId: input.source.agentId, requestId: input.requestId, attemptId: input.attemptId }, body) }
    }

    async function aligned(input: DesktopSecretRequestDecision): Promise<{ request: RequestRow; fingerprint: string; providedKeys: string[]; entries: [string, string][] }> {
        const request = await requestById(db, input.requestId)
        if (!request || !sameSource(request.source, input.source) || request.revision !== input.expectedRevision) refusal(409, 'This credential request changed or belongs to another conversation.')
        const body = await bodyFingerprint(input, request.input.fields)
        return { request, ...body }
    }

    async function credentialVersions(query: Query, agentId: string, keys: readonly string[]): Promise<Record<string, number>> {
        const versions: Record<string, number> = {}
        for (const key of keys) {
            const row = (await query.execute({ sql: 'SELECT version FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', args: [agentId, key] })).rows[0]
            versions[key] = row ? Number(row.version) : 0
        }
        return versions
    }

    async function assertAttempt(query: Query, input: DesktopSecretRequestDecision, fingerprint: string): Promise<Row | null> {
        const row = (await query.execute({ sql: 'SELECT * FROM desktop_secret_attempts WHERE attempt_id = ?', args: [input.attemptId] })).rows[0]
        if (row && (String(row.request_id) !== input.requestId || String(row.operation) !== input.operation
            || String(row.expected_revision) !== input.expectedRevision || String(row.body_fingerprint) !== fingerprint)) {
            refusal(409, 'This attempt was already used for a different credential decision.')
        }
        return row ?? null
    }

    async function stageUnlocked(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority): Promise<DesktopSecretRequestView | (DesktopSecretRequestReceipt & { requestId: string })> {
        const { request, fingerprint, entries } = await aligned(input)
        const existingReceipt = await receiptById(db, request.requestId)
        if (existingReceipt) {
            if (existingReceipt.attemptId !== input.attemptId) refusal(409, 'This credential request already has a different receipt.')
            await assertAttempt(db, input, fingerprint)
            return existingReceipt
        }
        const previous = await assertAttempt(db, input, fingerprint)
        if (previous) {
            if (String(previous.state) === 'refused') refusal(409, 'This attempt was definitively refused.')
            if (String(previous.state) !== 'staged') refusal(409, 'This attempt is already sealed.')
            return viewOf(db, request)
        }
        authority.check()
        if (request.status !== 'pending') refusal(409, 'This credential request is no longer waiting for a decision.')
        const versions = await credentialVersions(db, request.source.agentId, entries.map(([key]) => key))
        const payload = input.operation === 'save'
            ? await crypto.seal({ domain: 'staging', agentId: request.source.agentId, key: request.requestId, requestId: request.requestId, attemptId: input.attemptId, version: 1 }, new TextEncoder().encode(JSON.stringify(entries)))
            : null
        const tx = await db.transaction('write')
        try {
            const racedReceipt = await receiptById(tx, request.requestId)
            if (racedReceipt) refusal(409, 'This credential request already has a receipt.')
            const raced = await assertAttempt(tx, input, fingerprint)
            if (raced) refusal(409, 'This attempt is already waiting for recovery.')
            await tx.execute({
                sql: `INSERT INTO desktop_secret_attempts
                    (attempt_id,request_id,operation,expected_revision,body_fingerprint,sealed_payload,credential_versions,state,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?)`,
                args: [input.attemptId, input.requestId, input.operation, input.expectedRevision, fingerprint, payload, JSON.stringify(versions), 'staged', new Date().toISOString()],
            })
            authority.check()
            await tx.commit()
        } catch (error) { await tx.rollback().catch(() => undefined); throw error }
        finally { tx.close() }
        return viewOf(db, request)
    }

    async function sealUnlocked(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority): Promise<DesktopSecretRequestReceipt & { requestId: string }> {
        const { request, fingerprint, entries, providedKeys } = await aligned(input)
        const existing = await receiptById(db, request.requestId)
        if (existing) {
            if (existing.attemptId !== input.attemptId) refusal(409, 'This credential request already has a different receipt.')
            await assertAttempt(db, input, fingerprint)
            return existing
        }
        authority.check()
        const tx = await db.transaction('write')
        try {
            const attempt = await assertAttempt(tx, input, fingerprint)
            if (!attempt || String(attempt.state) !== 'staged') refusal(409, 'This credential decision has no recoverable staged attempt.')
            const current = await requestById(tx, request.requestId)
            if (!current || current.status !== 'pending' || current.revision !== input.expectedRevision || !sameSource(current.source, input.source)) refusal(409, 'This credential request changed before it could be sealed.')
            const versions = await credentialVersions(tx, request.source.agentId, entries.map(([key]) => key))
            if (JSON.stringify(versions) !== JSON.stringify(JSON.parse(String(attempt.credential_versions)))) refusal(409, 'A credential changed while this decision was being saved. Review the request again.')
            let recovered = entries
            if (input.operation === 'save') {
                const payload = attempt.sealed_payload == null ? null : String(attempt.sealed_payload)
                if (!payload) refusal(409, 'The encrypted staged decision is unavailable.')
                const opened = await crypto.open({ domain: 'staging', agentId: request.source.agentId, key: request.requestId, requestId: request.requestId, attemptId: input.attemptId, version: 1 }, payload)
                recovered = JSON.parse(new TextDecoder().decode(opened))
            }
            const skippedKeys = request.input.fields.filter(field => !providedKeys.includes(field.key)).map(field => field.key)
            const summary = serializeDesktopSecretReceiptSummary(request.input.fields, providedKeys, input.operation)
            const continuationRequestId = randomUUID()
            const createdAt = new Date().toISOString()
            for (const [key, value] of recovered) {
                const version = versions[key] + 1
                const sealed = await crypto.seal({ domain: 'credential', agentId: request.source.agentId, key, version }, new TextEncoder().encode(value))
                const result = await tx.execute({
                    sql: `INSERT INTO desktop_secret_credentials(agent_id,key,version,sealed_value,updated_at) VALUES(?,?,?,?,?)
                        ON CONFLICT(agent_id,key) DO UPDATE SET version=excluded.version,sealed_value=excluded.sealed_value,updated_at=excluded.updated_at
                        WHERE desktop_secret_credentials.version = ?`,
                    args: [request.source.agentId, key, version, sealed, createdAt, versions[key]],
                })
                if (result.rowsAffected !== 1) refusal(409, 'A credential changed while this decision was being saved.')
            }
            await tx.execute({
                sql: `INSERT INTO desktop_secret_receipts
                    (request_id,attempt_id,decision,provided_keys,skipped_keys,summary_text,continuation_request_id,accepted,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?)`,
                args: [request.requestId, input.attemptId, input.operation, JSON.stringify(providedKeys), JSON.stringify(skippedKeys), summary, continuationRequestId, 0, createdAt],
            })
            await tx.execute({ sql: 'UPDATE desktop_secret_attempts SET state = ?, sealed_payload = NULL WHERE attempt_id = ?', args: ['sealed', input.attemptId] })
            await tx.execute({ sql: 'UPDATE desktop_secret_requests SET status = ?, updated_at = ? WHERE request_id = ? AND status = ?', args: ['sealed', createdAt, request.requestId, 'pending'] })
            authority.check()
            await tx.commit()
            return { requestId: request.requestId, attemptId: input.attemptId, decision: input.operation, providedKeys, skippedKeys, summary, continuationRequestId, accepted: false, createdAt }
        } catch (error) { await tx.rollback().catch(() => undefined); throw error }
        finally { tx.close() }
    }

    return {
        async publish(input: DesktopSecretRequestInput & { source: DesktopSecretRequestSource }): Promise<DesktopSecretRequestView> {
            const parsed = desktopSecretRequestInputSchema.parse({ fields: input.fields, ...(input.reason !== undefined ? { reason: input.reason } : {}) })
            const requestId = identity(input.source)
            const existing = await requestById(db, requestId)
            if (existing) {
                if (!sameSource(existing.source, input.source) || JSON.stringify(existing.input) !== JSON.stringify(parsed)) refusal(409, 'This source already delivered a different credential request.')
                return viewOf(db, existing)
            }
            const now = new Date().toISOString()
            const revision = randomUUID()
            await db.execute({
                sql: `INSERT INTO desktop_secret_requests
                    (request_id,agent_id,session_id,run_id,source_message_id,tool_call_id,fingerprint,ordered_input,reason,revision,status,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                args: [requestId, input.source.agentId, input.source.sessionId, input.source.runId, input.source.sourceMessageId, input.source.toolCallId,
                    input.source.fingerprint, JSON.stringify({ fields: parsed.fields }), parsed.reason ?? null, revision, 'pending', now, now],
            })
            const saved = await requestById(db, requestId)
            if (!saved) refusal(502, 'The credential request could not be saved.')
            return viewOf(db, saved)
        },

        async read(requestId: string): Promise<DesktopSecretRequestView | null> {
            const request = await requestById(db, requestId)
            return request ? viewOf(db, request) : null
        },

        async readBySource(source: DesktopSecretRequestSource): Promise<DesktopSecretRequestView | null> {
            const request = await requestById(db, identity(source))
            return request ? viewOf(db, request) : null
        },

        existingNames: (agentId: string) => existingNames(db, agentId),

        stage(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority) {
            return withRequestLock(input.requestId, async () => {
                const result = await stageUnlocked(input, authority)
                if ('summary' in result) return viewOf(db, (await requestById(db, input.requestId))!)
                return result
            })
        },

        sealStaged(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority) {
            return withRequestLock(input.requestId, () => sealUnlocked(input, authority))
        },

        decide(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority) {
            return withRequestLock(input.requestId, async () => {
                const staged = await stageUnlocked(input, authority)
                if ('summary' in staged) return staged
                return sealUnlocked(input, authority)
            })
        },

        async refuse(input: DesktopSecretRequestDecision): Promise<void> {
            return withRequestLock(input.requestId, async () => {
                const { fingerprint } = await aligned(input)
                if (await receiptById(db, input.requestId)) refusal(409, 'A sealed credential decision cannot be refused.')
                const attempt = await assertAttempt(db, input, fingerprint)
                if (!attempt) return
                if (String(attempt.state) === 'sealed') refusal(409, 'A sealed credential decision cannot be refused.')
                await db.execute({ sql: 'UPDATE desktop_secret_attempts SET state = ?, sealed_payload = NULL WHERE attempt_id = ? AND request_id = ?', args: ['refused', input.attemptId, input.requestId] })
            })
        },

        async discard(input: DesktopSecretRequestDecision): Promise<void> {
            return withRequestLock(input.requestId, async () => {
                const { fingerprint } = await aligned(input)
                if (await receiptById(db, input.requestId)) refusal(409, 'A sealed credential decision cannot be discarded.')
                await assertAttempt(db, input, fingerprint)
                await db.execute({ sql: 'DELETE FROM desktop_secret_attempts WHERE attempt_id = ? AND request_id = ?', args: [input.attemptId, input.requestId] })
            })
        },

        async markAccepted(requestId: string, continuationRequestId: string): Promise<void> {
            const receipt = await receiptById(db, requestId)
            if (!receipt || receipt.continuationRequestId !== continuationRequestId) refusal(409, 'Continuation belongs to a different credential receipt.')
            if (receipt.accepted) return
            await db.execute({ sql: 'UPDATE desktop_secret_receipts SET accepted = 1 WHERE request_id = ? AND continuation_request_id = ?', args: [requestId, continuationRequestId] })
            await db.execute({ sql: 'UPDATE desktop_secret_requests SET status = ?, updated_at = ? WHERE request_id = ?', args: ['accepted', new Date().toISOString(), requestId] })
        },

        async useCredential<T>(agentId: string, key: string, authority: DesktopSecretRequestAuthority, use: (value: Uint8Array) => T | Promise<T>): Promise<T> {
            authority.check()
            const row = (await db.execute({ sql: 'SELECT version,sealed_value FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', args: [agentId, key] })).rows[0]
            if (!row) refusal(404, 'Credential not found for this coworker.')
            const value = await crypto.open({ domain: 'credential', agentId, key, version: Number(row.version) }, String(row.sealed_value))
            return use(value)
        },
    }
}

export type DesktopSecretRequestStore = ReturnType<typeof createDesktopSecretRequestStore>
