'use client'

import { QUICK_REPLIES_TOOL, stripBridgePrefix, toolLabelOf } from '@rerun/contracts'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { getToolName, isToolUIPart, type UIMessage } from 'ai'

import { ChatActivityPresentation } from '@/components/chat/ChatActivityPresentation'
import { liveActivityLabel, stepGroupShowsActivity } from '@/lib/agent-chat-loader'
import { desktopCompactionSteps } from '@/lib/desktop/compaction'
import { isDesktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { useDesktopLocale } from './DesktopLocale'
import { projectDesktopToolStatus } from './tool-presentations/status'

export function DesktopChatActivity({ agentId, message, stopping = false }: {
    agentId: string
    message?: UIMessage
    stopping?: boolean
}) {
    const { t } = useDesktopLocale()
    const labels = [t('chatActivity.thinking'), t('chatActivity.processing'), t('chatActivity.crafting')]
    const indicator = <AgentBuddy agentId={agentId} mood="working" size={24} facing="right" />
    if (stopping) return <ChatActivityPresentation activity={t('stoppingRun')} labels={labels} indicator={indicator} announce />

    let activity: string | null = null
    if (message?.role === 'assistant') {
        const compactions = desktopCompactionSteps(message.parts, true)
        if ([...compactions.values()].some(step => step.data.status === 'running')) return null
        const last = message.parts.findLast(part => !part.type.startsWith('data-'))
        if (last?.type === 'reasoning' && last.state === 'streaming' && isDesktopSummaryMetadata(last.providerMetadata)) return null
        if (last && isToolUIPart(last)) {
            if (last.state === 'approval-requested') return null
            const toolName = stripBridgePrefix(getToolName(last))
            if (toolName !== QUICK_REPLIES_TOOL && projectDesktopToolStatus(last, { ownerId: agentId }) === 'running') {
                if (stepGroupShowsActivity(message)) return null
            } else {
                // A non-visible or settled step is not a reliable label for current activity.
                return <ChatActivityPresentation activity={null} labels={labels} indicator={indicator} announce />
            }
        }
        activity = liveActivityLabel(message, name => toolLabelOf(name), {
            activity: (key, values) => t(`chatActivity.${key}`, values),
            trouble: ({ stalled, failing }) => [
                stalled > 0 ? t('subRunTrouble.stalled', { count: stalled }) : '',
                failing > 0 ? t('subRunTrouble.failing', { count: failing }) : '',
            ].filter(Boolean).map(label => ` · ${label}`).join(''),
        })
    }
    return <ChatActivityPresentation activity={activity} labels={labels} indicator={indicator} announce />
}
