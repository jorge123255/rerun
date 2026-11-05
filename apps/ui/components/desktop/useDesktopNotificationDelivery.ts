'use client'

import { useEffect, useRef } from 'react'
import { playNotificationSoundOnce } from '@/lib/notifications/browser'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { desktopNotificationsBridge, type DesktopNotificationTarget } from '@/lib/desktop/notification-bridge'
import { DESKTOP_NOTIFICATION_EVENTS_URL, DESKTOP_NOTIFICATION_SEEN_URL, DESKTOP_NOTIFICATION_TERMIALS_URL, desktopNotificationEventsSchema, desktopTerminalBindingSchema } from '@/lib/desktop/notifications'
import { DESKTOP_COMPLETIONS_URL, desktopCompletionsSchema } from '@/lib/desktop/completed-actions'
import { DESKTOP_ATTENTION_URL, desktopAttentionSchema } from '@/lib/desktop/attention'

export const DESKTOP_NOTIFICATION_POLL_MS = 3000

type DeliveryArgs = {
    /** Navigation only: opens the exact coworker/session a click revalidated, never answering. */
    onOpenConversation?: (target: { agentId: string; sessionId: string }) => void
    /** The conversation currently on screen (root-supplied): its own events stay in-app, and a
     * request that left the visible chat announces once it can. */
    visibleSessionId?: string | null
}

const routeClick = async (target: DesktopNotificationTarget, navigate?: (target: { agentId: string; sessionId: string }) => void): Promise<void> => {
    if (target.kind === 'done' || target.kind === 'error') {
        if (target.groupId) {
            const response = await fetch(DESKTOP_COMPLETIONS_URL, { cache: 'no-store' })
            if (!response.ok) return
            const body = desktopCompletionsSchema.parse(await response.json())
            // The group may have advanced since the announcement: navigate to its newest conversation.
            const group = body.items.find(item => item.id === target.groupId && item.agentId === target.agentId)
            if (!group) return
            navigate?.({ agentId: group.agentId, sessionId: group.sessionId })
            return
        }
        if (!target.terminalId) return
        const response = await fetch(`${DESKTOP_NOTIFICATION_TERMIALS_URL}/${encodeURIComponent(target.terminalId)}`, { cache: 'no-store' })
        if (!response.ok) return
        const binding = desktopTerminalBindingSchema.parse(await response.json())
        navigate?.(binding)
        return
    }
    if (!target.requestId) return
    const response = await fetch(DESKTOP_ATTENTION_URL, { cache: 'no-store' })
    if (!response.ok) return
    const body = desktopAttentionSchema.parse(await response.json())
    const item = body.items.find(candidate => candidate.id === target.requestId
        && candidate.agentId === target.agentId && candidate.sessionId === target.sessionId)
    if (!item) return
    navigate?.({ agentId: item.agentId, sessionId: item.sessionId })
}

// Polls the local notification events on a fixed interval, visible or not — a hidden window is
// exactly when a notification matters. Each new event announces through the shell's own
// Notification (root-reviewed bridge), plays the original's sound for what needs the user, and
// is then acknowledged once, so polling, reconnecting and restarting never replay history.
// Clicks revalidate the exact owner/chat/request before navigating; nothing is ever answered.
export function useDesktopNotificationDelivery({ onOpenConversation, visibleSessionId }: DeliveryArgs = {}): void {
    const navigation = useRef(onOpenConversation)
    navigation.current = onOpenConversation
    const notified = useRef(new Set<string>())
    const inFlight = useRef(false)
    const mounted = useRef(true)
    const visible = useRef(visibleSessionId)
    visible.current = visibleSessionId

    useEffect(() => {
        mounted.current = true
        const tick = async () => {
            if (!mounted.current || inFlight.current || isDesktopQuitting()) return
            inFlight.current = true
            try {
                const response = await fetch(DESKTOP_NOTIFICATION_EVENTS_URL, { cache: 'no-store' })
                if (!response.ok) return
                const body = desktopNotificationEventsSchema.parse(await response.json())
                if (!mounted.current || isDesktopQuitting()) return
                const bridge = desktopNotificationsBridge()
                const announced: string[] = []
                for (const event of body.events) {
                    if (notified.current.has(event.key)) continue
                    // The conversation on screen carries its own card: an OS notification would be
                    // a redundant duplicate, and the event stays unseen until it can announce.
                    if (event.sessionId === visible.current) continue
                    if (body.channels.toast) bridge.notify({
                        key: event.key, kind: event.kind, agentId: event.agentId, sessionId: event.sessionId,
                        groupId: event.groupId ?? null, terminalId: event.terminalId ?? null, requestId: event.requestId ?? null,
                        title: event.title, subtitle: event.subtitle, body: event.body ?? undefined, silent: event.silent,
                    })
                    if (body.channels.sound && event.kind !== 'done') playNotificationSoundOnce(event.key)
                    announced.push(event.key)
                    notified.current.add(event.key)
                }
                if (announced.length) void fetch(DESKTOP_NOTIFICATION_SEEN_URL, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ keys: announced }), cache: 'no-store',
                }).catch(() => {})
            } catch {
                // The next tick retries; nothing was announced or acknowledged.
            } finally {
                inFlight.current = false
            }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, DESKTOP_NOTIFICATION_POLL_MS)
        return () => { mounted.current = false; clearInterval(timer) }
    }, [])

    useEffect(() => {
        const { onClick } = desktopNotificationsBridge()
        const stop = onClick(target => { void routeClick(target, target => navigation.current?.(target)) })
        return stop
    }, [])
}
