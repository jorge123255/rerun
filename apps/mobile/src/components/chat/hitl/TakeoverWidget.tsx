import { ChatScreen } from '@/components/chat/screen/ChatScreen'
import { useAgentScreen } from '@/components/chat/screen/useAgentScreen'
import { useTakeoverRequest } from '@/components/chat/screen/useTakeoverRequest'

import type { HitlWidgetProps } from './registry'

// The coworker needs the person in its browser: a login, a captcha. The ask sits under its live
// screen, as on the web; the screen opens full size on the page it asked for, and Done, there or
// here, answers with where the browser was left.
export function TakeoverWidget({ pending, agentId, coworkerName, onAnswer }: HitlWidgetProps) {
    const takeover = useTakeoverRequest(agentId, coworkerName, pending, onAnswer)
    const screen = useAgentScreen(agentId, true)
    return <ChatScreen status={screen.status} uri={screen.uri} onMessage={screen.onMessage} attachWebView={screen.attachWebView} site={takeover?.site ?? null} takeover={takeover} onTakeControl={() => takeover?.onOpen()} />
}
