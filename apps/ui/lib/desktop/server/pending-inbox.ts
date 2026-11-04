import 'server-only'
import { z } from 'zod'
import type { DesktopPendingInbox, DesktopPendingReadTarget } from '../pending-inbox'
import { readDesktopAttention } from './attention'
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
    const result = await db.execute({ sql: `SELECT item_id FROM desktop_pending_inbox_seen WHERE item_id IN (${ids.map(() => '?').join(',')})`, args: ids })
    const seen = new Set(result.rows.map(row => String(row.item_id)))
    return { items: attention.items.filter(item => !seen.has(item.id)), unavailableAgentIds: attention.unavailableAgentIds, checkedAt: attention.checkedAt }
}

export const desktopPendingInboxReadSchema = z.object({
    items: z.array(z.object({
        id: z.string().min(1).max(8192),
        kind: z.enum(['question', 'approval']),
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
    // A session holds at most one pending request, so one engine re-read serves all of its targets.
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
                    signal.throwIfAborted()
                    const current = item.kind === 'question'
                        ? await readDesktopQuestion(runtime, session.id, { signal })
                        : await readDesktopApproval(runtime, session.id, { signal })
                    const currentId = item.kind === 'question' ? current.question?.id ?? null : current.approval?.id ?? null
                    if (currentId === item.id) confirmed.push(item)
                    else failed.add(item.id)
                }
            } catch { for (const item of items) failed.add(item.id) }
        }
    })
    await Promise.all(workers)
    // Sessions the deadline cut short remain explicitly unknown, never acknowledged.
    for (const sessionId of sessions.slice(next)) for (const item of bySession.get(sessionId)!) failed.add(item.id)

    if (!confirmed.length) return { marked: 0, failedIds: [...failed] }
    const transaction = await db.transaction('write')
    try {
        const seenAt = new Date().toISOString()
        for (const item of confirmed) {
            // Re-check the live binding inside the write so a deletion or rebinding during the
            // engine reads cannot acknowledge a different chat, and receipts cascade with the row.
            const row = (await transaction.execute({ sql: 'SELECT id, agent_id FROM desktop_sessions WHERE id = ?', args: [item.sessionId] })).rows[0]
            if (!row || String(row.agent_id) !== item.agentId) throw new Error('Pending binding changed')
            await transaction.execute({ sql: 'INSERT INTO desktop_pending_inbox_seen (item_id, agent_id, session_id, kind, seen_at) VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO NOTHING', args: [item.id, item.agentId, item.sessionId, item.kind, seenAt] })
        }
        await transaction.commit()
    } catch {
        // A partial write failure persists nothing: every target stays visible and retryable.
        await transaction.rollback().catch(() => {})
        return { marked: 0, failedIds: targets.map(item => item.id) }
    } finally {
        transaction.close()
    }
    return { marked: confirmed.length, failedIds: [...failed] }
}
