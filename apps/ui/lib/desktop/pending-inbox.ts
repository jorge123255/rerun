import { z } from 'zod'
import { desktopAttentionItemSchema, type DesktopAttentionItem } from './attention'

// The desktop pending-inbox contract: the shared attention projection filtered by durable,
// inbox-only read receipts. The receipts are keyed on the exact pending request identity the
// attention endpoint already publishes (owner + session + question/approval source message,
// tool-call and fingerprint), so a new request in the same chat always reappears, and opening a
// row never acknowledges anything.

// One row of the pending inbox: the same shape as the shared attention projection, minus the
// items this user already marked read.
export const desktopPendingInboxSchema = z.object({
    items: z.array(desktopAttentionItemSchema),
    // A partial read cannot be presented as an empty or fully resolved workspace.
    unavailableAgentIds: z.array(z.string()),
    checkedAt: z.string(),
})
export type DesktopPendingInboxItem = DesktopAttentionItem
export type DesktopPendingInbox = z.infer<typeof desktopPendingInboxSchema>
export const DESKTOP_PENDING_INBOX_URL = '/api/desktop/pending-inbox'
export const DESKTOP_PENDING_INBOX_READ_URL = '/api/desktop/pending-inbox/read'

// The explicit mark-read target. The server ignores the binding claims for anything except
// locating the session; it re-reads the current pending request and only stores a receipt when
// its recomputed identity matches the published item id. The request body schema lives server-side
// (like `desktopCompletionReadSchema`); this type keeps the client and the server in sync.
export type DesktopPendingReadTarget = {
    id: string
    kind: 'question' | 'approval'
    agentId: string
    sessionId: string
}

// The mark-read reply: `failedIds` are the exact item ids that stayed visible — stale, unknown or
// unreachable requests are never reported as complete success.
export const desktopPendingInboxReadResultSchema = z.object({
    marked: z.number().int().min(0),
    failedIds: z.array(z.string()),
}).strict()
export type DesktopPendingInboxReadResult = z.infer<typeof desktopPendingInboxReadResultSchema>

export function readTargetOf(item: DesktopPendingInboxItem): DesktopPendingReadTarget {
    return { id: item.id, kind: item.kind, agentId: item.agentId, sessionId: item.sessionId }
}
