import type { DesktopCompletionItem } from '../completed-actions'
import type { DesktopPendingInboxItem, DesktopPendingReadTarget } from '../pending-inbox'

// The Mac's Actions inbox as a paired phone lists it: what waits on the person, then what finished
// since they last looked. Each row is named by an id only the Mac can take apart: to mark a row read
// the phone sends that id back, and the Mac looks the row up again in its own inbox, so a phone never
// names a request, a conversation or a completion of its choosing.
export type PhoneInboxItem = {
    id: string
    state: 'question' | 'approval' | 'on-mac' | 'done'
    agentId: string
    agentName: string
    sessionId: string
    sessionIds: string[]
    title: string
    message: string | null
    updatedAt: string
    count: number
}

const PENDING = 'p:'
const DONE = 'd:'

export function phoneInboxItems(pending: readonly DesktopPendingInboxItem[], done: readonly DesktopCompletionItem[]): PhoneInboxItem[] {
    return [
        ...pending.map((item): PhoneInboxItem => ({
            id: PENDING + item.id,
            // Only a question or an approval can be settled from a phone; the rest is the Mac's.
            state: item.kind === 'question' ? 'question' : item.kind === 'approval' ? 'approval' : 'on-mac',
            agentId: item.agentId, agentName: item.agentName, sessionId: item.sessionId, sessionIds: [item.sessionId],
            title: item.title, message: item.summary || null, updatedAt: item.requestedAt ?? item.updatedAt, count: 1,
        })),
        ...done.map((item): PhoneInboxItem => ({
            id: DONE + item.id, state: 'done', agentId: item.agentId, agentName: item.agentName, sessionId: item.sessionId, sessionIds: item.sessionIds,
            title: item.title, message: item.message, updatedAt: item.completedAt, count: item.count,
        })),
    ]
}

// The rows the phone asked to mark read, found again in the inbox as it stands now. An id the inbox
// no longer holds marks nothing.
export function phoneInboxReadTargets(ids: readonly string[], pending: readonly DesktopPendingInboxItem[], done: readonly DesktopCompletionItem[]): { items: DesktopPendingReadTarget[]; completionIds: string[] } {
    const asked = new Set(ids)
    return {
        items: pending.filter(item => asked.has(PENDING + item.id)).map(({ id, kind, agentId, sessionId }) => ({ id, kind, agentId, sessionId })),
        completionIds: done.filter(item => asked.has(DONE + item.id)).flatMap(item => item.completionIds),
    }
}
