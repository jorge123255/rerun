'use client'

import { useEffect, useRef } from 'react'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { desktopNotificationsBridge, type DesktopNotificationTarget, type DesktopNotificationDeliveryResult } from '@/lib/desktop/notification-bridge'
import { DESKTOP_NOTIFICATION_EVENTS_URL, DESKTOP_NOTIFICATION_ADMIT_URL, DESKTOP_NOTIFICATION_DELIVERY_URL, DESKTOP_NOTIFICATION_TERMIALS_URL, desktopNotificationAdmissionsSchema, desktopNotificationEventsSchema, desktopTerminalBindingSchema } from '@/lib/desktop/notifications'
import { DESKTOP_COMPLETIONS_URL, desktopCompletionsSchema } from '@/lib/desktop/completed-actions'
import { DESKTOP_ATTENTION_URL, desktopAttentionSchema } from '@/lib/desktop/attention'

export const DESKTOP_NOTIFICATION_POLL_MS = 3000
type DeliveryArgs = { onOpenConversation?: (target: { agentId: string; sessionId: string }) => void; visibleSessionId?: string | null }

async function routeClick(target: DesktopNotificationTarget, signal: AbortSignal): Promise<{ agentId: string; sessionId: string } | null> {
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

async function playSound(signal: AbortSignal): Promise<boolean> {
    let audio: HTMLAudioElement | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        if (signal.aborted) return false
        audio = new Audio('/sounds/notification.mp3')
        const stop = () => audio?.pause()
        signal.addEventListener('abort', stop, { once: true })
        try {
            const started = await Promise.race([audio.play().then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => { stop(); resolve(false) }, 2000) })])
            return started && !signal.aborted
        } finally { signal.removeEventListener('abort', stop) }
    } catch { return false }
    finally { clearTimeout(timer) }
}

async function boundedDelivery(work: Promise<DesktopNotificationDeliveryResult>): Promise<DesktopNotificationDeliveryResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([work, new Promise<DesktopNotificationDeliveryResult>(resolve => { timer = setTimeout(() => resolve({ status: 'unknown' }), 5000) })]) }
    finally { clearTimeout(timer) }
}

/** Durable admission precedes native display; ambiguous IPC/crash outcomes stay
 * consumed instead of replaying an alert the OS may already have shown. */
export function useDesktopNotificationDelivery({ onOpenConversation, visibleSessionId }: DeliveryArgs = {}): void {
    const navigation = useRef(onOpenConversation); navigation.current = onOpenConversation
    const visible = useRef(visibleSessionId); visible.current = visibleSessionId
    useEffect(() => {
        const lifetime = new AbortController()
        let busy = false
        const tick = async () => {
            if (busy || lifetime.signal.aborted || isDesktopQuitting()) return
            busy = true
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
            try {
                const response = await fetch(DESKTOP_NOTIFICATION_EVENTS_URL, { cache: 'no-store', signal })
                if (!response.ok) return
                const body = desktopNotificationEventsSchema.parse(await response.json())
                if (signal.aborted || isDesktopQuitting()) return
                const bridge = desktopNotificationsBridge()
                const keys = body.events.filter(event => !(document.visibilityState === 'visible' && event.sessionId === visible.current)
                    && ((body.channels.toast && bridge.available) || (body.channels.sound && event.kind !== 'done'))).slice(0, 50).map(event => event.key)
                if (!keys.length) return
                const admission = await fetch(DESKTOP_NOTIFICATION_ADMIT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }), cache: 'no-store', signal })
                if (!admission.ok) return
                const admitted = desktopNotificationAdmissionsSchema.parse(await admission.json())
                for (const event of admitted.events) {
                    let status: DesktopNotificationDeliveryResult['status'] = 'unavailable'
                    if (!signal.aborted && !isDesktopQuitting()) {
                        if (admitted.channels.toast && bridge.available) {
                            // The original sound asset below is the sole sound, avoiding a double ring.
                            status = (await boundedDelivery(bridge.notify({ key: event.key, kind: event.kind, agentId: event.agentId, sessionId: event.sessionId,
                                groupId: event.groupId ?? null, terminalId: event.terminalId ?? null, requestId: event.requestId ?? null,
                                title: event.title, subtitle: event.subtitle, silent: true, body: event.body ?? undefined }))).status
                        }
                        if (admitted.channels.sound && event.kind !== 'done' && await playSound(signal)) status = 'shown'
                    }
                    // Receipt loss preserves admission. Only definite nondelivery with the exact
                    // token may release it; an old response cannot clear a newer attempt.
                    await fetch(DESKTOP_NOTIFICATION_DELIVERY_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ key: event.key, attemptId: event.attemptId, status }), cache: 'no-store', signal: AbortSignal.timeout(5000) }).catch(() => {})
                }
            } catch { /* Next poll retries unadmitted events; admitted ambiguity never replays. */ }
            finally { busy = false }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, DESKTOP_NOTIFICATION_POLL_MS)
        return () => { lifetime.abort(); clearInterval(timer) }
    }, [])

    useEffect(() => {
        let active = true
        let click: AbortController | undefined
        const stop = desktopNotificationsBridge().onClick(target => {
            click?.abort()
            click = new AbortController()
            const signal = AbortSignal.any([click.signal, AbortSignal.timeout(5000)])
            void routeClick(target, signal).then(binding => {
                if (active && !signal.aborted && !isDesktopQuitting() && binding) navigation.current?.(binding)
            }).catch(() => {})
        })
        return () => { active = false; click?.abort(); stop() }
    }, [])
}
