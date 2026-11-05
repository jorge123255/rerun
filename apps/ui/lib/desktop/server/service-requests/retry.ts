import 'server-only'
import type { Client } from '@libsql/client'
import { desktopServiceRequestMutationSchema, type DesktopServiceRequestMutation } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { ServiceRequestDatabase, ServiceRequestScope } from './service'

// Shared across route bundles: a refusal cannot discard an attempt while another
// POST for that conversation is still deciding whether to commit it.
const key = Symbol.for('rerun.desktop.service-request-attempts.v1')
const globalLocks = globalThis as typeof globalThis & { [key]?: Map<string, Promise<void>> }
const locks = globalLocks[key] ??= new Map<string, Promise<void>>()
export function withDesktopServiceRequestAttempt<T>(scope: ServiceRequestScope, run: () => Promise<T>): Promise<T> {
    const id = JSON.stringify([scope.agentId, scope.sessionId])
    const previous = locks.get(id) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(() => undefined, () => undefined)
    locks.set(id, settled)
    void settled.then(() => { if (locks.get(id) === settled) locks.delete(id) })
    return result
}

async function owned(db: ServiceRequestDatabase, scope: ServiceRequestScope, serviceRequestId: string) {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_service_suggestion_requests WHERE service_request_id = ? AND agent_id = ? AND session_id = ?', args: [serviceRequestId, scope.agentId, scope.sessionId] })).rows[0]
    if (!row) throw new DesktopHttpError(404, 'App request not found in this conversation.')
    return row
}

function encode(input: DesktopServiceRequestMutation): string {
    const body = JSON.stringify(desktopServiceRequestMutationSchema.parse(input))
    if (Buffer.byteLength(body) > 32_768) throw new DesktopHttpError(413, 'App decisions exceed the saved retry limit.')
    return body
}

export async function readDesktopServiceRetry(db: ServiceRequestDatabase, scope: ServiceRequestScope, serviceRequestId: string) {
    await owned(db, scope, serviceRequestId)
    const row = (await db.execute({ sql: 'SELECT body FROM desktop_service_suggestion_retry WHERE service_request_id = ?', args: [serviceRequestId] })).rows[0]
    return row ? desktopServiceRequestMutationSchema.parse(JSON.parse(String(row.body))) : null
}

export class DesktopServiceRetryRejected extends DesktopHttpError { constructor() { super(409, 'Those app decisions were refused. Refresh the card and choose again.') } }

export async function reserveDesktopServiceRetry(db: Client, scope: ServiceRequestScope, input: DesktopServiceRequestMutation) {
    const body = encode(input)
    const tx = await db.transaction('write')
    try {
        const card = await owned(tx, scope, input.serviceRequestId)
        if (card.source_message_id !== input.source.sourceMessageId || card.tool_call_id !== input.source.toolCallId || card.fingerprint !== input.source.fingerprint) throw new DesktopHttpError(409, 'This app request changed. Refresh the conversation.')
        const rejected = (await tx.execute({ sql: 'SELECT request_id,service_request_id,body FROM desktop_service_suggestion_rejections WHERE request_id = ?', args: [input.requestId] })).rows[0]
        if (rejected) {
            if(rejected.service_request_id === input.serviceRequestId && rejected.body === encode(input)) throw new DesktopServiceRetryRejected()
            throw new DesktopHttpError(409, 'This attempt belongs to other app decisions.')
        }
        const previous = await readDesktopServiceRetry(tx, scope, input.serviceRequestId)
        if (previous && encode(previous) !== body) throw new DesktopHttpError(409, 'Retry the saved app decisions before choosing again.')
        await tx.execute({ sql: 'INSERT INTO desktop_service_suggestion_retry(service_request_id, request_id, body, updated_at) VALUES(?,?,?,?) ON CONFLICT(service_request_id) DO NOTHING', args: [input.serviceRequestId, input.requestId, body, new Date().toISOString()] })
        await tx.commit()
        return input
    } catch (error) { await tx.rollback().catch(() => undefined); throw error } finally { tx.close() }
}

/** Only a definitive refusal before a mutation/receipt was committed can release
 * the exact intent. HTTP errors after a sealed Finish remain retryable. */
export async function rejectDesktopServiceRetry(db: Client, scope: ServiceRequestScope, input: DesktopServiceRequestMutation): Promise<boolean> {
    const tx = await db.transaction('write')
    try {
        await owned(tx, scope, input.serviceRequestId)
        const mutation = (await tx.execute({ sql: 'SELECT request_id FROM desktop_service_suggestion_mutations WHERE request_id = ?', args: [input.requestId] })).rows[0]
        const receipt = (await tx.execute({ sql: 'SELECT request_id FROM desktop_service_suggestion_receipts WHERE service_request_id = ?', args: [input.serviceRequestId] })).rows[0]
        if (mutation || receipt) { await tx.commit(); return false }
        // Keep a tombstone: a delayed retry of a definite refusal cannot later
        // become accepted after the user has already started making new choices.
        await tx.execute({ sql: 'INSERT INTO desktop_service_suggestion_rejections(request_id, service_request_id, body) VALUES(?,?,?) ON CONFLICT(request_id) DO NOTHING', args: [input.requestId, input.serviceRequestId, encode(input)] })
        await tx.execute({ sql: 'DELETE FROM desktop_service_suggestion_retry WHERE service_request_id = ? AND request_id = ? AND body = ?', args: [input.serviceRequestId, input.requestId, encode(input)] })
        await tx.commit()
        return true
    } catch (error) { await tx.rollback().catch(() => undefined); throw error } finally { tx.close() }
}

export async function acknowledgeDesktopServiceRetry(db: Client, scope: ServiceRequestScope, input: DesktopServiceRequestMutation) {
    const tx = await db.transaction('write')
    try {
        const card = await owned(tx, scope, input.serviceRequestId)
        const previous = await readDesktopServiceRetry(tx, scope, input.serviceRequestId)
        if (!previous) { await tx.commit(); return }
        if (encode(previous) !== encode(input)) throw new DesktopHttpError(409, 'A different app decision is still waiting for acknowledgement.')
        const mutation = (await tx.execute({ sql: 'SELECT * FROM desktop_service_suggestion_mutations WHERE request_id = ?', args: [input.requestId] })).rows[0]
        const receipt = (await tx.execute({ sql: 'SELECT * FROM desktop_service_suggestion_receipts WHERE service_request_id = ?', args: [input.serviceRequestId] })).rows[0]
        const confirmed = input.action === 'progress'
            ? mutation?.kind === 'progress' && mutation.service_request_id === input.serviceRequestId && mutation.expected_revision === input.expectedRevision && mutation.body === JSON.stringify({ currentIndex: input.currentIndex, choices: input.choices })
            : Number(receipt?.accepted) === 1 && receipt?.revision === input.expectedRevision && card.revision === input.expectedRevision && card.choices === JSON.stringify(input.choices) && Number(card.current_index) === input.currentIndex
        if (!confirmed) throw new DesktopHttpError(409, 'The saved app decisions have not been confirmed. Retry them first.')
        await tx.execute({ sql: 'DELETE FROM desktop_service_suggestion_retry WHERE service_request_id = ? AND request_id = ?', args: [input.serviceRequestId, input.requestId] })
        await tx.commit()
    } catch (error) { await tx.rollback().catch(() => undefined); throw error } finally { tx.close() }
}
