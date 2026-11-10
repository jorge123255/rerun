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
    activeAttemptId?: string
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
const fingerprint = (input: DesktopMcpSignInDecision) => createHash('sha256').update(JSON.stringify(['desktop-mcp-sign-in-attempt-v1', input.operation, input.source])).digest('hex')

function requestOf(row: Row): RequestRow {
    return {
        requestId: String(row.request_id),
        source: {
            agentId: String(row.agent_id), sessionId: String(row.session_id), runId: String(row.run_id), sourceMessageId: String(row.source_message_id),
            toolCallId: String(row.tool_call_id), fingerprint: String(row.fingerprint), server: desktopMcpSignInServerSchema.parse(JSON.parse(String(row.server_snapshot))),
        },
        input: desktopMcpSignInRequestInputSchema.parse(JSON.parse(String(row.ordered_input))),
        ...(row.active_attempt_id == null ? {} : { activeAttemptId: String(row.active_attempt_id) }),
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
        ...(request.activeAttemptId ? { activeAttemptId: request.activeAttemptId } : {}),
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
    if (row && (String(row.request_id) !== input.requestId || String(row.operation) !== input.operation || String(row.body_fingerprint) !== bodyFingerprint)) {
        refusal(409, 'This sign-in attempt was already used for a different decision.')
    }
    return row ?? null
}

export function createDesktopMcpSignInStore(db: Client) {
    async function read(requestId: string, query: Query = db): Promise<DesktopMcpSignInView | null> {
        const request = await requestById(query, requestId)
        return request ? viewOf(request, await receiptById(query, requestId)) : null
    }
    async function transaction<T>(requestId: string, work: (tx: Awaited<ReturnType<Client['transaction']>>) => Promise<T>): Promise<T> {
        return withLock(requestId, async () => {
            const tx = await db.transaction('write')
            try { const result = await work(tx); await tx.commit(); return result }
            catch (error) { await tx.rollback().catch(() => undefined); throw error }
            finally { tx.close() }
        })
    }
    async function exact(db: Query, input: DesktopMcpSignInDecision) {
        const request = await requestById(db, input.requestId)
        if (!request || !sameSource(request.source, input.source)) refusal(409, 'This MCP sign-in belongs to another source.')
        return request
    }
    async function pending(db: Query, input: DesktopMcpSignInDecision) {
        const { request, bodyFingerprint } = await aligned(db, input)
        const attempt = await assertAttempt(db, { ...input, operation: 'connect' }, fingerprint({ ...input, operation: 'connect' }))
        if (!attempt || attempt.state !== 'pending' || request.activeAttemptId !== input.attemptId || await receiptById(db, input.requestId)) refusal(409, 'This sign-in attempt is no longer active.')
        return { request, bodyFingerprint }
    }
    async function update(db: Query, requestId: string, status: RequestRow['status'], active: string | null, error: string | null = null) {
        await db.execute({ sql: 'UPDATE desktop_mcp_sign_in_requests SET status=?, active_attempt_id=?, revision=?, error=?, updated_at=? WHERE request_id=?', args: [status, active, randomUUID(), error, new Date().toISOString(), requestId] })
    }
    async function beginAttempt(input: DesktopMcpSignInDecision, authority: DesktopMcpSignInAuthority) {
        if (input.operation !== 'connect') refusal(400, 'Only Connect starts OAuth.')
        authority.check()
        return transaction(input.requestId, async tx => {
            const request = await exact(tx, input), receipt = await receiptById(tx, input.requestId)
            if (receipt) { authority.check(); return { request: viewOf(request, receipt), created: false } }
            const prior = await assertAttempt(tx, input, fingerprint(input))
            if (prior) {
                if (prior.state !== 'pending' || request.activeAttemptId !== input.attemptId) refusal(409, 'This sign-in attempt is no longer active. Start a new attempt.')
                authority.check(); return { request: viewOf(request, null), created: false }
            }
            if (request.revision !== input.expectedRevision || request.activeAttemptId) refusal(409, 'This MCP sign-in changed. Reload it before connecting.')
            await tx.execute({ sql: 'INSERT INTO desktop_mcp_sign_in_attempts(attempt_id,request_id,operation,expected_revision,body_fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?)', args: [input.attemptId, input.requestId, 'connect', input.expectedRevision, fingerprint(input), 'pending', new Date().toISOString()] })
            await update(tx, input.requestId, 'connecting', input.attemptId)
            const next = (await requestById(tx, input.requestId))!
            authority.check(); return { request: viewOf(next, null), created: true }
        })
    }
    return {
        read, beginAttempt,
        async latestUnaccepted(agentId: string, sessionId: string) {
            const row = (await db.execute({ sql: 'SELECT r.* FROM desktop_mcp_sign_in_requests r LEFT JOIN desktop_mcp_sign_in_receipts d ON d.request_id=r.request_id WHERE r.agent_id=? AND r.session_id=? AND d.accepted=0 ORDER BY r.created_at DESC LIMIT 1', args: [agentId, sessionId] })).rows[0]
            return row ? viewOf(requestOf(row), await receiptById(db, String(row.request_id))) : null
        },
        async begin(input: DesktopMcpSignInDecision, authority: DesktopMcpSignInAuthority) { return (await beginAttempt(input, authority)).request },
        async readBySource(source: DesktopMcpSignInSource, query: Query = db) { return read(identity(source), query) },
        async validate(input: DesktopMcpSignInDecision, active = false) {
            const request = active ? (await pending(db, input)).request : await exact(db, input)
            if (!active && request.revision !== input.expectedRevision) refusal(409, 'This MCP sign-in request changed.')
            return viewOf(request, await receiptById(db, input.requestId))
        },
        async publish(input: DesktopMcpSignInRequestInput & { source: DesktopMcpSignInSource }, authority?: DesktopMcpSignInAuthority): Promise<DesktopMcpSignInView> {
            const parsed = desktopMcpSignInRequestInputSchema.parse({ name: input.name, ...(input.reason !== undefined ? { reason: input.reason } : {}) })
            const server = desktopMcpSignInServerSchema.parse(input.source.server)
            if (parsed.name !== server.name) refusal(409, 'MCP registration does not match the requested name.')
            const requestId = identity(input.source)
            authority?.check()
            return transaction(requestId, async tx => {
                const existing = await requestById(tx, requestId)
                if (existing) {
                    if (!sameSource(existing.source, input.source) || JSON.stringify(existing.input) !== JSON.stringify(parsed)) refusal(409, 'This source already delivered a different MCP sign-in request.')
                    const view = viewOf(existing, await receiptById(tx, requestId)); authority?.check(); return view
                }
                const now = new Date().toISOString()
                await tx.execute({ sql: `INSERT INTO desktop_mcp_sign_in_requests
                    (request_id,agent_id,session_id,run_id,source_message_id,tool_call_id,fingerprint,server_snapshot,ordered_input,reason,revision,status,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    args: [requestId, input.source.agentId, input.source.sessionId, input.source.runId, input.source.sourceMessageId, input.source.toolCallId, input.source.fingerprint, JSON.stringify(server), JSON.stringify(parsed), parsed.reason ?? null, randomUUID(), 'pending', now, now] })
                const view = viewOf((await requestById(tx, requestId))!, null); authority?.check(); return view
            })
        },
        async seal(input: DesktopMcpSignInDecision, outcome: DesktopMcpSignInReceipt['outcome'], authority: DesktopMcpSignInAuthority): Promise<Receipt> {
            if (input.operation === 'cancel' || outcome === 'connected' && input.operation !== 'connect' || outcome === 'declined' && input.operation !== 'decline') refusal(400, 'This decision does not match its outcome.')
            authority.check()
            return transaction(input.requestId, async tx => {
                const request = await exact(tx, input), existing = await receiptById(tx, input.requestId)
                if (existing) {
                    if (existing.attemptId !== input.attemptId || existing.outcome !== outcome) refusal(409, 'This MCP sign-in already has a different receipt.')
                    await assertAttempt(tx, input, fingerprint(input)); authority.check(); return existing
                }
                if (request.revision !== input.expectedRevision) refusal(409, 'This MCP sign-in request changed.')
                if (outcome === 'connected') await pending(tx, input)
                else {
                    const prior = await assertAttempt(tx, input, fingerprint(input))
                    if (prior) refusal(409, 'This sign-in decision was already used.')
                    await tx.execute({ sql: 'INSERT INTO desktop_mcp_sign_in_attempts(attempt_id,request_id,operation,expected_revision,body_fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?)', args: [input.attemptId, input.requestId, 'decline', input.expectedRevision, fingerprint(input), 'pending', new Date().toISOString()] })
                    if (request.activeAttemptId) await tx.execute({ sql: "UPDATE desktop_mcp_sign_in_attempts SET state='cancelled' WHERE attempt_id=? AND state='pending'", args: [request.activeAttemptId] })
                }
                const now = new Date().toISOString(), summary = serializeDesktopMcpSignInResult(request.source.server.name, outcome), continuationRequestId = randomUUID()
                await tx.execute({ sql: 'INSERT INTO desktop_mcp_sign_in_receipts(request_id,attempt_id,outcome,summary_text,continuation_request_id,accepted,created_at) VALUES(?,?,?,?,?,?,?)', args: [input.requestId, input.attemptId, outcome, summary, continuationRequestId, 0, now] })
                await tx.execute({ sql: "UPDATE desktop_mcp_sign_in_attempts SET state='sealed' WHERE attempt_id=?", args: [input.attemptId] })
                await update(tx, input.requestId, outcome, null)
                authority.check()
                return { requestId: input.requestId, attemptId: input.attemptId, outcome, summary, continuationRequestId, accepted: false, createdAt: now }
            })
        },
        async fail(input: DesktopMcpSignInDecision, _message: string, authority?: DesktopMcpSignInAuthority): Promise<DesktopMcpSignInView> {
            authority?.check()
            return transaction(input.requestId, async tx => {
                await pending(tx, input)
                await tx.execute({ sql: "UPDATE desktop_mcp_sign_in_attempts SET state='failed' WHERE attempt_id=?", args: [input.attemptId] })
                await update(tx, input.requestId, 'error', null, 'Authorization failed. Start a new sign-in attempt.')
                const view = viewOf((await requestById(tx, input.requestId))!, null); authority?.check(); return view
            })
        },
        async cancel(input: DesktopMcpSignInDecision, authority?: DesktopMcpSignInAuthority): Promise<DesktopMcpSignInView> {
            if (input.operation !== 'cancel') refusal(400, 'Cancel must close only the OAuth attempt.')
            authority?.check()
            return transaction(input.requestId, async tx => {
                await pending(tx, input)
                await tx.execute({ sql: "UPDATE desktop_mcp_sign_in_attempts SET state='cancelled' WHERE attempt_id=?", args: [input.attemptId] })
                await update(tx, input.requestId, 'pending', null)
                const view = viewOf((await requestById(tx, input.requestId))!, null); authority?.check(); return view
            })
        },
        async receipt(input: DesktopMcpSignInDecision): Promise<Receipt> {
            await exact(db, input)
            const receipt = await receiptById(db, input.requestId)
            if (!receipt || receipt.attemptId !== input.attemptId) refusal(409, 'This MCP sign-in has no matching sealed receipt.')
            return receipt
        },
        async markAccepted(requestId: string, continuationRequestId: string): Promise<void> {
            const result = await db.execute({ sql: 'UPDATE desktop_mcp_sign_in_receipts SET accepted=1 WHERE request_id=? AND continuation_request_id=?', args: [requestId, continuationRequestId] })
            if (result.rowsAffected !== 1) refusal(409, 'Continuation belongs to a different MCP sign-in receipt.')
        },
    }
}
export type DesktopMcpSignInStore = ReturnType<typeof createDesktopMcpSignInStore>
