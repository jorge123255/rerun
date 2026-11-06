'use client'

import type { ReactNode } from 'react'
import { parseVoiceMessage } from '@rerun/contracts'
import { isDesktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { DesktopVoiceMessageBubble } from './DesktopVoiceMessageBubble'

export function DesktopVoiceHistoryMessage({ agentId, text, children }: { agentId: string; text: string; children: ReactNode }) {
    const message = parseVoiceMessage(text)
    if (!message) return children
    // Tabs can be closed and reopened. Keep the recording's original scope; the server
    // checks that this coworker still owns the saved voice message before serving bytes.
    let scope
    try {
        const url = new URL(message.src, 'http://127.0.0.1')
        scope = { agentId, tabUid: url.searchParams.get('tabUid') ?? '', sessionId: url.searchParams.get('sessionId') ?? undefined }
        if (!scope.tabUid || !isDesktopVoiceAudioReference(scope, message.src)) return children
    } catch { return children }
    return <DesktopVoiceMessageBubble scope={scope} {...message} />
}
