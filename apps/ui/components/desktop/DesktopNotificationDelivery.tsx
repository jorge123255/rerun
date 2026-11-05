'use client'

import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { useDesktopNotificationDelivery } from './useDesktopNotificationDelivery'

export type DesktopNotificationDeliveryProps = {
    /** Navigation only: opens the exact coworker/session a click revalidated, never answering. */
    onOpenConversation?: (hit: Pick<DesktopConversationHit, 'agentId' | 'sessionId' | 'title'>) => void
    /** The conversation currently on screen (root-supplied), so its own events stay in-app. */
    visibleSessionId?: string | null
}

// Renders nothing. Mount once in the shell's app root: it polls the local notification events,
// announces them through the root-reviewed native bridge and routes clicks that revalidate the
// exact owner/chat/request before navigating.
export function DesktopNotificationDelivery({ onOpenConversation, visibleSessionId }: DesktopNotificationDeliveryProps) {
    useDesktopNotificationDelivery({ onOpenConversation: onOpenConversation ? target => onOpenConversation({ agentId: target.agentId, sessionId: target.sessionId, title: '' }) : undefined, visibleSessionId })
    return null
}
