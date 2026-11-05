import { z } from 'zod'
import { desktopAttentionSchema, type DesktopAttention } from './attention'

// What the Team board knows about a coworker. `unreachable` is a failed read and must never look idle;
// `unknown` is the state before the first read lands.
export const boardActivityStatus = z.enum(['working', 'waiting_human', 'idle', 'unreachable'])
export type BoardActivityStatus = z.infer<typeof boardActivityStatus> | 'unknown'
export const emptyBoardAttention = (): DesktopAttention => ({ items: [], unavailableAgentIds: [], checkedAt: '' })
export const boardActivitySchema = z.object({ agents: z.record(z.string(), boardActivityStatus), attention: desktopAttentionSchema.default(emptyBoardAttention) })
export type BoardActivity = z.infer<typeof boardActivitySchema>
export type BoardActivitySnapshot = { statuses: Record<string, BoardActivityStatus>; attention: DesktopAttention }

// A confirmed pending request can direct a click only for a current, reachable local coworker.
// A failed/partial read cannot manufacture an idle state or keep an old navigation target alive.
export function boardActivityForAgents(activity: BoardActivity, agentIds: string[]): BoardActivitySnapshot {
    const known = new Set(agentIds)
    const items = activity.attention.items.filter(item => known.has(item.agentId)
        && activity.agents[item.agentId] !== undefined && activity.agents[item.agentId] !== 'unreachable')
    const pending = new Set(items.map(item => item.agentId))
    const unavailable = new Set(activity.attention.unavailableAgentIds.filter(id => known.has(id)))
    const statuses = Object.fromEntries(agentIds.map(id => {
        const status = activity.agents[id]
        return [id, status === 'unreachable' || status === 'working' ? status
            : pending.has(id) ? 'waiting_human' : unavailable.has(id) ? 'unreachable'
                : status === 'waiting_human' || status === undefined ? 'unknown' : status]
    })) as Record<string, BoardActivityStatus>
    return { statuses, attention: { ...activity.attention, items, unavailableAgentIds: [...unavailable] } }
}

export function latestBoardAttention(attention: DesktopAttention, agentId: string) {
    return attention.items.filter(item => item.agentId === agentId).sort((a, b) =>
        (Date.parse(b.requestedAt ?? b.updatedAt) || 0) - (Date.parse(a.requestedAt ?? a.updatedAt) || 0) || a.id.localeCompare(b.id))[0]
}
export const BOARD_ACTIVITY_URL = '/api/desktop/board-activity'
export const BOARD_ACTIVITY_POLL_MS = 3000
