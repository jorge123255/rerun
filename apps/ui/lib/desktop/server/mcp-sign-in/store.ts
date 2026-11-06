import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import {
    desktopMcpSignInRequestInputSchema,
    desktopMcpSignInServerSchema,
    serializeDesktopMcpSignInResult,
    type DesktopMcpSignInDecision,
    type DesktopMcpSignInReceipt,
    type DesktopMcpSignInRequestInput,
    type DesktopMcpSignInSource,
    type DesktopMcpSignInView,
} from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopHttpError } from '../auth'

export type DesktopMcpSignInAuthority = { check: () => void }
type Query = Pick<Client, 'execute'>
type RequestRow = {
    requestId: string
    source: DesktopMcpSignInSource
    input: DesktopMcpSignInRequestInput
    revision: string
    status: DesktopMcpSignInView['status']
    error?: string
    createdAt: string
    updatedAt: string
}
type Receipt = DesktopMcpSignInReceipt & { requestId: string }

const lockKey = Symbol.for('rerun.desktop.mcp-sign-in-writes.v1')
const host = globalThis as typeof globalThis & { [lockKey]?: Map<string, Promise<void>> }
const locks = host[lockKey] ??= new Map<string, Promise<void>>()
function withLock<T>(requestId: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(requestId) ?? Promise.resolve()
    const result = previous.then(action, action)
    const settled = result.then(() => undefined, () => undefined)
    locks.set(requestId, settled)
    void settled.then(() => { if (locks.get(requestId) === settled) locks.delete(requestId) })
    return result
}

function refusal(status: number, message: string): never { throw new DesktopHttpError(status, message) }
const identity = (source: DesktopMcpSignInSource) => createHash('sha256').update(JSON.stringify(['desktop-mcp-sign-in-v1', source])).digest('hex')
const sameSource = (a: DesktopMcpSignInSource, b: DesktopMcpSignInSource) => JSON.stringify(a) === JSON.stringify(b)
const fingerprint = (input: DesktopMcpSignInDecision) => createHash('sha256').update(JSON.stringify(['desktop-mcp-sign-in-attempt-v1', input.operation, input.expectedRevision, input.source])).digest('hex')

function requestOf(row: Row): RequestRow {
    return {
        requestId: String(row.request_id),
        source: {
            agentId: String(row.agent_id), sessionId: String(row.session_id), runId: String(row.run_id), sourceMessageId: String(row.source_message_id),
            toolCallId: String(row.tool_call_id), fingerprint: String(row.fingerprint), server: desktopMcpSignInServerSchema.parse(JSON.parse(String(row.server_snapshot))),
        },
        input: desktopMcpSignInRequestInputSchema.parse(JSON.parse(String(row.ordered_input))),
        revision: String(row.revision), status: String(row.status) as RequestRow['status'], ...(row.error == null ? {} : { error: String(row.error) }),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
}

function receiptOf(row: Row): Receipt {
    return { requestId: String(row.request_id), attemptId: String(row.attempt_id), outcome: String(row.outcome) as Receipt['outcome'], summary: String(row.summary_text), continuationRequestId: String(row.continuation_request_id), accepted: Number(row.accepted) === 1, createdAt: String(row.created_at) }
}

async function requestById(db: Query, requestId: string): Promise<RequestRow | null> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_mcp_sign_in_requests WHERE request_id = ?', args: [requestId] })).rows[0]
    return row ? requestOf(row) : null
}
async function receiptById(db: Query, requestId: string): Promise<Receipt | null> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_mcp_sign_in_receipts WHERE request_id = ?', args: [requestId] })).rows[0]
    return row ? receiptOf(row) : null
}
function viewOf(request: RequestRow, receipt: Receipt | null): DesktopMcpSignInView {
    return {
        requestId: request.requestId, revision: request.revision, source: request.source,
        ...(request.input.reason !== undefined ? { reason: request.input.reason } : {}), status: request.status,
        ...(request.error !== undefined ? { error: request.error } : {}),
        ...(receipt ? { receipt: { attemptId: receipt.attemptId, outcome: receipt.outcome, summary: receipt.summary, continuationRequestId: receipt.continuationRequestId, accepted: receipt.accepted, createdAt: receipt.createdAt } } : {}),
        createdAt: request.createdAt, updatedAt: request.updatedAt,
    }
}

async function aligned(db: Query, input: DesktopMcpSignInDecision): Promise<{ request: RequestRow; bodyFingerprint: string }> {
    const request = await requestById(db, input.requestId)
    if (!request || !sameSource(request.source, input.source) || request.revision !== input.expectedRevision) refusal(409, 'This MCP sign-in request changed or belongs to another conversation.')
    return { request, bodyFingerprint: fingerprint(input) }
}
async function assertAttempt(db: Query, input: DesktopMcpSignInDecision, bodyFingerprint: string): Promise<Row | null> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_mcp_sign_in_attempts WHERE attempt_id = ?', args: [input.attemptId] })).rows[0]
    if (row && (String(row.request_id) !== input.requestId || String(row.operation) !== input.operation || String(row.expected_revision) !== input.expectedRevision || String(row.body_fingerprint) !== bodyFingerprint)) {
        refusal(409, 'This sign-in attempt was already used for a different decision.')
    }
    return row ?? null
}

export function createDesktopMcpSignInStore(db: Client) {
    async function read(requestId: string): Promise<DesktopMcpSignInView | null> {
        const request = await requestById(db, requestId)
        return request ? viewOf(request, await receiptById(db, requestId)) : null
    }
    return {
        read,
        async readBySource(source: DesktopMcpSignInSource) { return read(identity(source)) },

        async publish(input: DesktopMcpSignInRequestInput & { source: DesktopMcpSignInSource }): Promise<DesktopMcpSignInView> {
            const parsed = desktopMcpSignInRequestInputSchema.parse({ name: input.name, ...(input.reason !== undefined ? { reason: input.reason } : {}) })
            const server = desktopMcpSignInServerSchema.parse(input.source.server)
            const requestId = identity(input.source)
            const existing = await requestById(db, requestId)
            if (existing) {
                if (!sameSource(existing.source, input.source) || JSON.stringify(existing.input) !== JSON.stringify(parsed)) refusal(409, 'This source already delivered a different MCP sign-in request.')
                return viewOf(existing, await receiptById(db, requestId))
            }
            const now = new Date().toISOString()
            await db.execute({
                sql: `INSERT INTO desktop_mcp_sign_in_requests
                    (request_id,agent_id,session_id,run_id,source_message_id,tool_call_id,fingerprint,server_snapshot,ordered_input,reason,revision,status,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                args: [requestId, input.source.agentId, input.source.sessionId, input.source.runId, input.source.sourceMessageId, input.source.toolCallId, input.source.fingerprint,
                    JSON.stringify(server), JSON.stringify(parsed), parsed.reason ?? null, randomUUID(), 'pending', now, now],
            })
            return (await read(requestId))!
        },

        async begin(input: DesktopMcpSignInDecision, authority: DesktopMcpSignInAuthority): Promise<DesktopMcpSignInView> {
            if (input.operation !== 'connect') refusal(400, 'Only Connect starts OAuth.')
            return withLock(input.requestId, async () => {
                const { request, bodyFingerprint } = await aligned(db, input)
                const existingReceipt = await receiptById(db, input.requestId)
                if (existingReceipt) return viewOf(request, existingReceipt)
                await assertAttempt(db, input, bodyFingerprint)
                authority.check()
                const now = new Date().toISOString()
                await db.execute({ sql: 'INSERT INTO desktop_mcp_sign_in_attempts(attempt_id,request_id,operation,expected_revision,body_fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING', args: [input.attemptId, input.requestId, input.operation, input.expectedRevision, bodyFingerprint, 'pending', now] })
                await db.execute({ sql: 'UPDATE desktop_mcp_sign_in_requests SET status = ?, error = NULL, updated_at = ? WHERE request_id = ?', args: ['connecting', now, input.requestId] })
                return (await read(input.requestId))!
            })
        },

        async seal(input: DesktopMcpSignInDecision, outcome: DesktopMcpSignInReceipt['outcome'], authority: DesktopMcpSignInAuthority): Promise<Receipt> {
            if (input.operation === 'cancel' || outcome === 'connected' && input.operation !== 'connect' || outcome === 'declined' && input.operation !== 'decline') refusal(400, 'This decision does not match its outcome.')
            return withLock(input.requestId, async () => {
                const { request, bodyFingerprint } = await aligned(db, input)
                const existing = await receiptById(db, input.requestId)
                if (existing) {
                    if (existing.attemptId !== input.attemptId || existing.outcome !== outcome) refusal(409, 'This MCP sign-in already has a different receipt.')
                    await assertAttempt(db, input, bodyFingerprint)
                    return existing
                }
                authority.check()
                const tx = await db.transaction('write')
                try {
                    const raced = await receiptById(tx, input.requestId)
                    if (raced) refusal(409, 'This MCP sign-in already has a receipt.')
                    await assertAttempt(tx, input, bodyFingerprint)
                    const now = new Date().toISOString()
                    await tx.execute({ sql: 'INSERT INTO desktop_mcp_sign_in_attempts(attempt_id,request_id,operation,expected_revision,body_fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING', args: [input.attemptId, input.requestId, input.operation, input.expectedRevision, bodyFingerprint, 'pending', now] })
                    const summary = serializeDesktopMcpSignInResult(request.source.server.name, outcome)
                    const continuationRequestId = randomUUID()
                    await tx.execute({ sql: 'INSERT INTO desktop_mcp_sign_in_receipts(request_id,attempt_id,outcome,summary_text,continuation_request_id,accepted,created_at) VALUES(?,?,?,?,?,?,?)', args: [input.requestId, input.attemptId, outcome, summary, continuationRequestId, 0, now] })
                    await tx.execute({ sql: 'UPDATE desktop_mcp_sign_in_attempts SET state = ? WHERE attempt_id = ?', args: ['sealed', input.attemptId] })
                    await tx.execute({ sql: 'UPDATE desktop_mcp_sign_in_requests SET status = ?, error = NULL, updated_at = ? WHERE request_id = ?', args: [outcome === 'connected' ? 'connected' : 'declined', now, input.requestId] })
                    authority.check()
                    await tx.commit()
                    return { requestId: input.requestId, attemptId: input.attemptId, outcome, summary, continuationRequestId, accepted: false, createdAt: now }
                } catch (error) { await tx.rollback().catch(() => undefined); throw error }
                finally { tx.close() }
            })
        },

        async fail(input: DesktopMcpSignInDecision, message: string): Promise<DesktopMcpSignInView> {
            return withLock(input.requestId, async () => {
                const { bodyFingerprint } = await aligned(db, input)
                await assertAttempt(db, input, bodyFingerprint)
                if (await receiptById(db, input.requestId)) return (await read(input.requestId))!
                const safe = message.slice(0, 400) || 'Authorization failed. Retry.'
                await db.execute({ sql: 'UPDATE desktop_mcp_sign_in_requests SET status = ?, error = ?, updated_at = ? WHERE request_id = ?', args: ['error', safe, new Date().toISOString(), input.requestId] })
                return (await read(input.requestId))!
            })
        },

        async cancel(input: DesktopMcpSignInDecision): Promise<DesktopMcpSignInView> {
            if (input.operation !== 'cancel') refusal(400, 'Cancel must close only the OAuth attempt.')
            return withLock(input.requestId, async () => {
                await aligned(db, input)
                const connectAttempt = { ...input, operation: 'connect' as const }
                await assertAttempt(db, connectAttempt, fingerprint(connectAttempt))
                if (await receiptById(db, input.requestId)) refusal(409, 'A completed sign-in cannot be cancelled.')
                await db.execute({ sql: 'DELETE FROM desktop_mcp_sign_in_attempts WHERE attempt_id = ? AND request_id = ?', args: [input.attemptId, input.requestId] })
                await db.execute({ sql: 'UPDATE desktop_mcp_sign_in_requests SET status = ?, error = NULL, updated_at = ? WHERE request_id = ?', args: ['pending', new Date().toISOString(), input.requestId] })
                return (await read(input.requestId))!
            })
        },

        async receipt(input: DesktopMcpSignInDecision): Promise<Receipt> {
            await aligned(db, input)
            const receipt = await receiptById(db, input.requestId)
            if (!receipt || receipt.attemptId !== input.attemptId) refusal(409, 'This MCP sign-in has no matching sealed receipt.')
            return receipt
        },

        async markAccepted(requestId: string, continuationRequestId: string): Promise<void> {
            const receipt = await receiptById(db, requestId)
            if (!receipt || receipt.continuationRequestId !== continuationRequestId) refusal(409, 'Continuation belongs to a different MCP sign-in receipt.')
            if (receipt.accepted) return
            await db.execute({ sql: 'UPDATE desktop_mcp_sign_in_receipts SET accepted = 1 WHERE request_id = ? AND continuation_request_id = ?', args: [requestId, continuationRequestId] })
        },
    }
}

export type DesktopMcpSignInStore = ReturnType<typeof createDesktopMcpSignInStore>
