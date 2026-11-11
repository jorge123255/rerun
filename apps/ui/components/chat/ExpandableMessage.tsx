'use client'

import { AgentWorkspaceMessage } from '@/components/chat/AgentWorkspaceMessage'
import type { ComposerMention } from '@/lib/chat/composer-links'
import { ExpandableMessageBody } from './ExpandableMessageBody'

type ExpandableMessageProps = {
    agentId?: string
    mentions?: ComposerMention[]
    children: string
}

export function ExpandableMessage({ agentId, mentions, children }: ExpandableMessageProps) {
    return (
        <ExpandableMessageBody>
            <AgentWorkspaceMessage agentId={agentId} composerTokens mentions={mentions}>
                {children}
            </AgentWorkspaceMessage>
        </ExpandableMessageBody>
    )
}
