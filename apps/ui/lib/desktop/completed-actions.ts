import { z } from 'zod'

// The desktop completion contract: finished-run cards projected from the engine's desktop-only
// completion store. Pending questions/approvals stay on the attention endpoint; this slice is
// completed in-app activity only.

// A raw completion after the server mapped engine agent/session ids onto current local desktop
// ids and joined the session title. The engine record itself comes from the terminal-event hook,
// so `source`/`slug` mirror the original RunTrigger.
export type CompletionRow = {
    id: string
    agentId: string
    sessionId: string
    runId: string | null
    source: 'chat' | 'schedule' | 'trigger'
    slug: string | null
    completedAt: string
    text: string | null
    provider: string | null
    model: string | null
    costMicros: number | null
    stepCount: number | null
    title: string
}

// The terminal notification message truncates the final answer to 200 characters; a completion
// card reuses the same bound, with the same « Message completed » fallback.
export const CHAT_MESSAGE_MAX = 200

export function boundedMessage(text: string | null | undefined): string {
    const trimmed = (text ?? '').trim()
    return trimmed.slice(0, CHAT_MESSAGE_MAX) || 'Message completed'
}

// One line of the inbox. Every run of the same scheduled task is folded into one line, exactly as
// the original `unseen-runs` projection: an hourly task left alone for a day is « ×24 », not
// twenty-four lines. Chat runs fold by their conversation.
export type CompletionGroup = {
    key: string
    agentId: string
    source: CompletionRow['source']
    slug: string | null
    /** The newest conversation of the group: the navigation target when the row is opened. */
    sessionId: string
    /** Newest first, like the rows the store returns. */
    sessionIds: string[]
    title: string
    /** The final-answer summary for chat rows; a scheduled row shows its name instead. */
    message: string | null
    count: number
    completedAt: string
    /** The exact terminal completion identities folded into this row (mark-read target). */
    completionIds: string[]
}

export function groupKeyOf(row: Pick<CompletionRow, 'agentId' | 'sessionId' | 'source' | 'slug'>): string {
    const scheduled = row.source !== 'chat' && !!row.slug
    return scheduled ? `${row.agentId}:${row.source}:${row.slug}` : row.sessionId
}

// Newest first, like the rows the store returns.
export function groupCompletions(rows: CompletionRow[]): CompletionGroup[] {
    const groups = new Map<string, CompletionGroup>()
    for (const row of rows) {
        const key = groupKeyOf(row)
        const at = new Date(row.completedAt).getTime()
        const scheduled = row.source !== 'chat' && !!row.slug
        const group = groups.get(key)
        if (!group) {
            groups.set(key, {
                key,
                agentId: row.agentId,
                source: row.source,
                slug: row.slug,
                sessionId: row.sessionId,
                sessionIds: [row.sessionId],
                title: scheduled ? row.slug! : row.title,
                message: scheduled ? null : boundedMessage(row.text),
                count: 1,
                completedAt: row.completedAt,
                completionIds: [row.id],
            })
            continue
        }
        group.sessionIds.push(row.sessionId)
        group.count += 1
        group.completionIds.push(row.id)
        if (at > new Date(group.completedAt).getTime()) {
            Object.assign(group, { completedAt: row.completedAt, sessionId: row.sessionId })
            if (!scheduled) Object.assign(group, { title: row.title, message: boundedMessage(row.text) })
        }
    }
    return [...groups.values()].sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime() || a.key.localeCompare(b.key))
}

// Stable bounded pagination on terminal identity and time: the cursor is the (completed_at, id)
// pair of the oldest completion a page consumed.
const CURSOR_SEPARATOR = '__'

export function cursorOf(row: Pick<CompletionRow, 'completedAt' | 'id'>): string {
    return `${row.completedAt}${CURSOR_SEPARATOR}${row.id}`
}

export function parseCursor(value: string | null | undefined): { completedAt: string; id: string } | null {
    if (!value) return null
    const sep = value.lastIndexOf(CURSOR_SEPARATOR)
    if (sep <= 0 || sep >= value.length - CURSOR_SEPARATOR.length) return null
    return { completedAt: value.slice(0, sep), id: value.slice(sep + CURSOR_SEPARATOR.length) }
}

export const desktopCompletionItemSchema = z.object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    agentName: z.string(),
    agentEnabled: z.boolean(),
    /** The newest conversation of the group: the navigation target when the row is opened. */
    sessionId: z.string().min(1),
    sessionIds: z.array(z.string()),
    title: z.string(),
    message: z.string().nullable(),
    source: z.enum(['chat', 'schedule', 'trigger']),
    slug: z.string().nullable(),
    count: z.number().int().positive(),
    completedAt: z.string(),
    /** The exact terminal completion identities folded into this row. */
    completionIds: z.array(z.string()),
})
export const desktopCompletionsSchema = z.object({
    items: z.array(desktopCompletionItemSchema),
    // A partial read cannot be presented as an empty list: some coworkers were unreachable.
    unavailableAgentIds: z.array(z.string()),
    // The first-enable cutoff: the list covers completions recorded after it, never a backfill.
    enabledAt: z.string(),
    // Stable cursor for the next older page; null when the current page is the oldest.
    nextCursor: z.string().nullable(),
    checkedAt: z.string(),
})
export type DesktopCompletionItem = z.infer<typeof desktopCompletionItemSchema>
export type DesktopCompletions = z.infer<typeof desktopCompletionsSchema>
export const DESKTOP_COMPLETIONS_URL = '/api/desktop/completions'
export const DESKTOP_COMPLETIONS_READ_URL = '/api/desktop/completions/read'
