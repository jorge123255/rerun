/** Navigation intents — matches I's foremanNavigationIntentSchema; live-only. */

import { acceptsForemanReply, isLiveForemanView, type DesktopForemanLiveScope } from './identity'

export type DesktopForemanNavigationIntent =
    | { kind: 'open_coworker'; agentId: string; sessionId: string | null }
    | { kind: 'open_box'; spaceId: string }
    | { kind: 'open_setup'; agentId: string }

export type DesktopForemanNavigationRequest = {
    intent: DesktopForemanNavigationIntent
    workspaceId: string
    chatId: string
    runId: string | null
    /** Must be true only while ConversationView.live is non-null and observed. */
    liveObserved: boolean
}

export function canDispatchForemanNavigation(
    live: DesktopForemanLiveScope,
    conversationLive: { runId: string } | null,
    request: DesktopForemanNavigationRequest,
): boolean {
    if (!request.liveObserved || !isLiveForemanView(conversationLive)) return false
    return acceptsForemanReply(live, {
        workspaceId: request.workspaceId,
        chatId: request.chatId,
        runId: request.runId,
        planRevisionId: live.planRevisionId,
    })
}
