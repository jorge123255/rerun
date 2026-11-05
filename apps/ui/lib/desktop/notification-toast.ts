'use client'

import { isScheduledSource } from '@rerun/contracts'
import { toast } from 'sonner'
import { NotificationToast } from '@/components/notifications/NotificationToast'
import type { NotificationKind } from '@/lib/engine/types'
import { CalendarClock } from '@/lib/icons'
import { KIND_BEAM, KIND_ICONS, KIND_ICON_COLORS } from '@/lib/notifications/kind-visuals'
import type { DesktopNotificationTarget } from './notification-bridge'
import { resolveDesktopNotificationClick } from './notification-click'
import type { DesktopNotificationAdmission } from './notifications'

export function desktopNotificationToastTarget(event: DesktopNotificationAdmission): DesktopNotificationTarget {
    return {
        key: event.key, kind: event.kind, agentId: event.agentId, sessionId: event.sessionId,
        groupId: event.groupId ?? null, terminalId: event.terminalId ?? null, requestId: event.requestId ?? null,
    }
}

// The in-app half of a desktop notification: the original toast card verbatim — same buddy,
// beam, copy rules and « Open conversation », which revalidates the exact chat before it
// navigates, exactly like a native click. The toast id is the event key, so a remount cannot
// announce the same admission twice.
export function showDesktopNotificationToast(event: DesktopNotificationAdmission, onOpenConversation?: (target: { agentId: string; sessionId: string }) => void): void {
    const id = `desktop-notification:${event.key}`
    const scheduled = isScheduledSource(event.source)
    const kind = event.kind as NotificationKind
    const Icon = scheduled ? CalendarClock : KIND_ICONS[kind]
    const iconColor = scheduled ? 'text-violet-400' : KIND_ICON_COLORS[kind]
    const beamTone = scheduled ? 'brand' : KIND_BEAM[kind]
    const target = desktopNotificationToastTarget(event)
    toast.custom(toastId => (
        <NotificationToast
            title={scheduled ? `${event.title} · Scheduled task` : event.title}
            message={event.body ?? event.subtitle}
            agentId={event.agentId}
            Icon={Icon}
            iconColor={iconColor}
            beamTone={beamTone}
            onDismiss={() => toast.dismiss(toastId)}
            onOpen={onOpenConversation ? () => {
                toast.dismiss(toastId)
                void resolveDesktopNotificationClick(target, AbortSignal.timeout(5000))
                    .then(binding => { if (binding) onOpenConversation(binding) })
                    .catch(() => {})
            } : undefined}
        />
    ), { id })
}
