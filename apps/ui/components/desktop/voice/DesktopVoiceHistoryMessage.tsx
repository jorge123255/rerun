'use client'

import type { ReactNode } from 'react'
import { parseVoiceMessage } from '@rerun/contracts'
import { isDesktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { interactionKey, type ChatInteractionIdentity } from '@/lib/desktop/chat-interactions/identity'
import { DesktopVoiceMessageBubble } from './DesktopVoiceMessageBubble'

type VoiceContext = {
    workspaceId?: number | null
    tabUid?: string
    sessionId: string | null
    messageId: string
    active: boolean
}

export function DesktopVoiceHistoryMessage({ agentId, text, context, children, renderPlayer }: {
    agentId: string
    text: string
    context: VoiceContext
    children: ReactNode
    renderPlayer?: (player: ReactNode) => ReactNode
}) {
    const message = parseVoiceMessage(text)
    if (!message) return children
    // The audio URL preserves the original custody scope, including a recording made
    // before the tab had a session. The transcript actions belong to the visible chat.
    let scope
    try {
        const url = new URL(message.src, 'http://127.0.0.1')
        scope = { agentId, tabUid: url.searchParams.get('tabUid') ?? '', sessionId: url.searchParams.get('sessionId') ?? undefined }
        if (!scope.tabUid || !isDesktopVoiceAudioReference(scope, message.src)) return children
    } catch { return children }
    const { workspaceId, tabUid, sessionId, messageId, active } = context
    const identity: ChatInteractionIdentity | undefined = workspaceId && tabUid && sessionId
        ? { workspaceId, agentId, tabUid, sessionId, messageId, sourceFingerprint: text }
        : undefined
    return <DesktopVoiceMessageBubble key={identity ? interactionKey(identity) : message.src}
        scope={scope} identity={identity} active={active} renderPlayer={renderPlayer} {...message} />
}
