import { readDesktopServiceRequestView } from './service-requests/view'
import { readDesktopSecretRequestView } from './secret-requests/binding'
import 'server-only'
import { z } from 'zod'
import type { DesktopPendingInbox, DesktopPendingReadTarget } from '../pending-inbox'
import { readDesktopAttention } from './attention'
import { readDesktopTakeover } from './takeover'
import { readDesktopApproval } from './approvals'
import { openDesktopDatabase } from './database'
import { initializeDesktopPendingInbox } from './pending-inbox-db'
import { readDesktopQuestion } from './questions'
import type { DesktopRuntime } from './runtime'
import { findDesktopSession } from './store'

export const DESKTOP_PENDING_INBOX_CONCURRENCY = 4
export const DESKTOP_PENDING_INBOX_DEADLINE_MS = 2_500
export { initializeDesktopPendingInbox, DESKTOP_PENDING_INBOX_SCHEMA } from './pending-inbox-db'

// The read is the shared attention projection with the inbox's own durable receipts subtracted.
// Nothing here answers, declines, approves or executes; the receipt only hides the row from this
// inbox, and the chat cards and the board keep showing the pending request until it is answered.
export async function readDesktopPendingInbox(runtime: DesktopRuntime): Promise<DesktopPendingInbox> {
    const attention = await readDesktopAttention(runtime)
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopPendingInbox(db)
    const ids = attention.items.map(item => item.id)
    if (!ids.length) return { items: [], unavailableAgentIds: attention.unavailableAgentIds, checkedAt: attention.checkedAt }
    const result = await db.execute({ sql: `SELECT item_id FROM desktop_pending_inbox_seen_v4 WHERE item_id IN (${ids.map(() => '?').join(',')})`, args: ids })
    const seen = new Set(result.rows.map(row => String(row.item_id)))
    return { items: attention.items.filter(item => !seen.has(item.id)), unavailableAgentIds: attention.unavailableAgentIds, checkedAt: attention.checkedAt }
}

export const desktopPendingInboxReadSchema = z.object({
    items: z.array(z.object({
        id: z.string().min(1).max(8192),
        kind: z.enum(['question', 'approval', 'takeover', 'service', 'secret']),
        agentId: z.string().min(1).max(200),
        sessionId: z.string().min(1).max(200),
    }).strict()).max(500),
}).strict()

export type DesktopPendingInboxReadInput = { items: DesktopPendingReadTarget[] }

// « Mark as read » on the Mac: each target is revalidated against the current pending request of
// its session before a receipt is stored, so a stale or forged id, a new request in the same chat
// or a resolved request never acknowledges the wrong thing. Retries are idempotent (upsert) and a
// partial outcome stays explicit in `failedIds`: the client keeps those rows visible with retry.
export async function markDesktopPendingInboxRead(runtime: DesktopRuntime, input: DesktopPendingInboxReadInput): Promise<{ marked: number; failedIds: string[] }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopPendingInbox(db)
    const unique = new Map<string, DesktopPendingReadTarget>()
    for (const item of input.items) if (!unique.has(item.id)) unique.set(item.id, item)
    const targets = [...unique.values()]
    if (!targets.length) return { marked: 0, failedIds: [] }

    const failed = new Set<string>()
    const confirmed: DesktopPendingReadTarget[] = []
    const signal = AbortSignal.timeout(DESKTOP_PENDING_INBOX_DEADLINE_MS)
    // Group by session so no two workers revalidate the same chat concurrently. A submitted
    // batch can include stale identities alongside the current request; each keeps its own result.
    const bySession = new Map<string, DesktopPendingReadTarget[]>()
    for (const item of targets) {
        const list = bySession.get(item.sessionId) ?? []
        list.push(item)
        bySession.set(item.sessionId, list)
    }
    const sessions = [...bySession.keys()]
    let next = 0
    const workers = Array.from({ length: Math.min(DESKTOP_PENDING_INBOX_CONCURRENCY, sessions.length) }, async () => {
        for (;;) {
            if (signal.aborted) return
            const sessionId = sessions[next++]
            if (!sessionId) return
            const items = bySession.get(sessionId)!
            try {
                const session = await findDesktopSession(db, sessionId)
                if (!session) { for (const item of items) failed.add(item.id); continue }
                for (const item of items) {
                    if (item.agentId !== session.agentId) { failed.add(item.id); continue }
                    try {
                        signal.throwIfAborted()
                        const service = item.kind === 'service' ? (await readDesktopServiceRequestView(runtime, session.id, { signal })).request : null
                        const currentId = item.kind === 'question'
                            ? (await readDesktopQuestion(runtime, session.id, { signal })).question?.id ?? null
                            : item.kind === 'takeover' ? (await readDesktopTakeover(runtime, session.id, { signal })).takeover?.id ?? null
                            : item.kind === 'service' ? service && !service.receipt?.accepted && service.retry.phase !== 'accepted' ? service.serviceRequestId : null
                            : item.kind === 'secret' ? (await readDesktopSecretRequestView(runtime, session.id, { signal })).request?.requestId ?? null
                            : (await readDesktopApproval(runtime, session.id, { signal })).approval?.id ?? null
                        // The resolver also reads local answer receipts after history arrives.
                        // A result that finishes after the scan deadline is still unknown.
                        signal.throwIfAborted()
                        if (currentId === item.id) confirmed.push(item)
                        else failed.add(item.id)
                    } catch {
                        // A later timeout in this chat must not report an earlier confirmed
                        // target as failed while its receipt is committed below.
                        failed.add(item.id)
                    }
                }
            } catch { for (const item of items) failed.add(item.id) }
        }
    })
    await Promise.all(workers)
    // Sessions the deadline cut short remain explicitly unknown, never acknowledged.
    for (const sessionId of sessions.slice(next)) for (const item of bySession.get(sessionId)!) failed.add(item.id)

    if (!confirmed.length) return { marked: 0, failedIds: [...failed] }
    const transaction = await db.transaction('write')
    let marked = 0
    try {
        const seenAt = new Date().toISOString()
        for (const item of confirmed) {
            // Re-check the live binding inside the write so a deletion or rebinding during the
            // engine reads cannot acknowledge a different chat, and receipts cascade with the row.
            const row = (await transaction.execute({ sql: 'SELECT id, agent_id FROM desktop_sessions WHERE id = ?', args: [item.sessionId] })).rows[0]
            if (!row || String(row.agent_id) !== item.agentId) throw new Error('Pending binding changed')
            if (item.kind === 'service') {
                // A Finish may be accepted after the resolver returned but before this write.
                const receipt = (await transaction.execute({ sql: 'SELECT accepted FROM desktop_service_suggestion_receipts WHERE service_request_id = ?', args: [item.id] })).rows[0]
                if (Number(receipt?.accepted) === 1) { failed.add(item.id); continue }
            }
            if (item.kind === 'secret') {
                const receipt = (await transaction.execute({ sql: 'SELECT accepted FROM desktop_secret_receipts WHERE request_id = ?', args: [item.id] })).rows[0]
                if (Number(receipt?.accepted) === 1) { failed.add(item.id); continue }
            }
            await transaction.execute({ sql: 'INSERT INTO desktop_pending_inbox_seen_v4 (item_id, agent_id, session_id, kind, seen_at) VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO NOTHING', args: [item.id, item.agentId, item.sessionId, item.kind, seenAt] })
            marked++
        }
        await transaction.commit()
    } catch {
        // A partial write failure persists nothing: every target stays visible and retryable.
        await transaction.rollback().catch(() => {})
        return { marked: 0, failedIds: targets.map(item => item.id) }
    } finally {
        transaction.close()
    }
    return { marked, failedIds: [...failed] }
}
