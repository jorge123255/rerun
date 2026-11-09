'use client'

import { useEffect, useRef } from 'react'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { desktopNotificationsBridge, type DesktopNotificationDeliveryResult, type DesktopNotificationTarget } from '@/lib/desktop/notification-bridge'
import { resolveDesktopNotificationClick } from '@/lib/desktop/notification-click'
import { showDesktopNotificationToast } from '@/lib/desktop/notification-toast'
import { DESKTOP_NOTIFICATION_EVENTS_URL, DESKTOP_NOTIFICATION_ADMIT_URL, DESKTOP_NOTIFICATION_DELIVERY_URL, desktopNotificationAdmissionsSchema, desktopNotificationEventsSchema } from '@/lib/desktop/notifications'

export const DESKTOP_NOTIFICATION_POLL_MS = 3000
type DeliveryArgs = { onOpenConversation?: (target: { agentId: string; sessionId: string }) => void; visibleSessionId?: string | null }

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

/** Durable admission precedes every surface; the in-app toast, the native alert and the
 * sound share the one attempt, so polling, reconnecting and restarting never replay. An
 * interrupted or ambiguous attempt stays consumed instead of risking a duplicate banner. */
export function useDesktopNotificationDelivery({ onOpenConversation, visibleSessionId }: DeliveryArgs = {}): void {
    const navigation = useRef(onOpenConversation); navigation.current = onOpenConversation
    const visible = useRef(visibleSessionId); visible.current = visibleSessionId
    useEffect(() => {
        const lifetime = new AbortController()
        let click: AbortController | undefined
        const openTarget = (target: DesktopNotificationTarget) => {
            click?.abort()
            const own = new AbortController()
            click = own
            const signal = AbortSignal.any([own.signal, lifetime.signal, AbortSignal.timeout(5000)])
            if (signal.aborted || isDesktopQuitting()) return
            void resolveDesktopNotificationClick(target, signal).then(binding => {
                if (click === own && !signal.aborted && !isDesktopQuitting() && binding) navigation.current?.(binding)
            }).catch(() => {})
        }
        const stopClicks = desktopNotificationsBridge().onClick(openTarget)
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
                const keys = body.events.filter(event => event.kind === 'info' || (!(document.visibilityState === 'visible' && event.sessionId === visible.current)
                    && (body.channels.toast || (body.channels.sound && event.kind !== 'done')))).slice(0, 50).map(event => event.key)
                if (!keys.length) return
                const admission = await fetch(DESKTOP_NOTIFICATION_ADMIT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }), cache: 'no-store', signal })
                if (!admission.ok) return
                const admitted = desktopNotificationAdmissionsSchema.parse(await admission.json())
                for (const event of admitted.events) {
                    if (event.kind === 'info') {
                        const looking = document.visibilityState === 'visible' && event.sessionId === visible.current
                        let status: DesktopNotificationDeliveryResult['status'] = 'unavailable'
                        let nativeStatus: DesktopNotificationDeliveryResult['status'] = 'unavailable'
                        if (!signal.aborted && !isDesktopQuitting() && !looking && admitted.channels.toast) {
                            showDesktopNotificationToast(event, openTarget)
                            status = 'shown'
                            if (bridge.available) {
                                const native = await boundedDelivery(bridge.notify({ key: event.key, kind: event.kind, agentId: event.agentId, sessionId: event.sessionId,
                                    groupId: event.groupId ?? null, terminalId: event.terminalId ?? null, requestId: event.requestId ?? null,
                                    title: event.title, subtitle: event.subtitle, silent: true, body: event.body ?? undefined }))
                                nativeStatus = native.status
                            }
                        }
                        if (!signal.aborted && !isDesktopQuitting() && !looking && admitted.channels.sound) await playSound(signal)
                        await fetch(DESKTOP_NOTIFICATION_DELIVERY_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ key: event.key, attemptId: event.attemptId, status, nativeStatus }), cache: 'no-store', signal: AbortSignal.timeout(5000) }).catch(() => {})
                        continue
                    }
                    let status: DesktopNotificationDeliveryResult['status'] = 'unavailable'
                    let nativeStatus: DesktopNotificationDeliveryResult['status'] | null = null
                    if (!signal.aborted && !isDesktopQuitting()) {
                        if (admitted.channels.toast) {
                            // The in-app card needs no bridge; the native alert is silent because
                            // the original sound asset below is the sole sound, avoiding a double ring.
                            showDesktopNotificationToast(event, openTarget)
                            status = 'shown'
                            if (bridge.available) {
                                const native = await boundedDelivery(bridge.notify({ key: event.key, kind: event.kind, agentId: event.agentId, sessionId: event.sessionId,
                                    groupId: event.groupId ?? null, terminalId: event.terminalId ?? null, requestId: event.requestId ?? null,
                                    title: event.title, subtitle: event.subtitle, silent: true, body: event.body ?? undefined }))
                                nativeStatus = native.status
                            }
                        }
                        if (admitted.channels.sound && event.kind !== 'done' && await playSound(signal)) status = 'shown'
                    }
                    // Receipt loss preserves admission. Only definite nondelivery with the exact
                    // token may release it; an old response cannot clear a newer attempt.
                    await fetch(DESKTOP_NOTIFICATION_DELIVERY_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ key: event.key, attemptId: event.attemptId, status, nativeStatus }), cache: 'no-store', signal: AbortSignal.timeout(5000) }).catch(() => {})
                }
            } catch { /* Next poll retries unadmitted events; admitted ambiguity never replays. */ }
            finally { busy = false }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, DESKTOP_NOTIFICATION_POLL_MS)
        return () => { lifetime.abort(); click?.abort(); stopClicks(); clearInterval(timer) }
    }, [])
}
