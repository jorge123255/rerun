'use client'

import { DESKTOP_ATTENTION_URL, desktopAttentionSchema } from '@/lib/desktop/attention'
import { DESKTOP_COMPLETIONS_URL, desktopCompletionsSchema } from '@/lib/desktop/completed-actions'
import type { DesktopNotificationTarget } from '@/lib/desktop/notification-bridge'
import { DESKTOP_NOTIFICATION_TERMIALS_URL, desktopTerminalBindingSchema } from '@/lib/desktop/notifications'

// The one revalidation every notification click goes through, native or in-app: the recorded
// identity is re-read live and only an exact current owner/chat/request may navigate. Anything
// stale, deleted or rebound resolves to null and the click lands nowhere.
export async function resolveDesktopNotificationClick(target: DesktopNotificationTarget, signal?: AbortSignal): Promise<{ agentId: string; sessionId: string } | null> {
    if (!target || !target.agentId || !target.sessionId) return null
    const options = { cache: 'no-store' as const, signal }
    if (target.kind === 'done') {
        if (!target.groupId) return null
        const response = await fetch(DESKTOP_COMPLETIONS_URL, options)
        if (!response.ok) return null
        const body = desktopCompletionsSchema.parse(await response.json())
        const group = body.items.find(item => item.id === target.groupId && item.agentId === target.agentId)
        // A newer folded completion must not redirect an old click to another chat.
        return group?.sessionIds.includes(target.sessionId) ? { agentId: target.agentId, sessionId: target.sessionId } : null
    }
    if (target.kind === 'error') {
        if (!target.terminalId) return null
        const response = await fetch(`${DESKTOP_NOTIFICATION_TERMIALS_URL}/${encodeURIComponent(target.terminalId)}`, options)
        if (!response.ok) return null
        const binding = desktopTerminalBindingSchema.parse(await response.json())
        return binding.agentId === target.agentId && binding.sessionId === target.sessionId ? binding : null
    }
    if ((target.kind !== 'question' && target.kind !== 'approval') || !target.requestId) return null
    const response = await fetch(DESKTOP_ATTENTION_URL, options)
    if (!response.ok) return null
    const body = desktopAttentionSchema.parse(await response.json())
    const item = body.items.find(candidate => candidate.id === target.requestId && candidate.kind === target.kind
        && candidate.agentId === target.agentId && candidate.sessionId === target.sessionId)
    return item ? { agentId: item.agentId, sessionId: item.sessionId } : null
}
