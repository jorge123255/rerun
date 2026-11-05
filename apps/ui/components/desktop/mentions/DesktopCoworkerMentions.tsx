'use client'

import { useCallback, type KeyboardEvent, type ReactNode } from 'react'
import type { DesktopSkillMentionsApi } from '@/components/desktop/DesktopSkillMentions'
import { useDesktopSkillSuggestions } from '@/lib/desktop/use-desktop-skill-suggestions'
import {
    revalidateDesktopCoworkerMentionsAtSend,
    useDesktopCoworkerMentionTargets,
    type DesktopCoworkerMention,
    type DesktopCoworkerMentionRevalidation,
    type DesktopCoworkerMentionTargetStatus,
} from '@/lib/desktop/coworker-mentions'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import { useDesktopMentionAutocomplete } from './useDesktopMentionAutocomplete'

export type DesktopCoworkerMentionsApi = DesktopSkillMentionsApi & {
    coworkerMentions: DesktopCoworkerMention[]
    targets: DesktopCoworkerCallTarget[]
    targetStatus: DesktopCoworkerMentionTargetStatus
    targetError: string | null
    retryTargets: () => void
    revalidateSend: () => Promise<DesktopCoworkerMentionRevalidation>
}

export function DesktopCoworkerMentions({ agentId, preferredBoxName, text, mentions, onTextChange, onMentionsChange, enabled = true, refreshKey, children }: {
    agentId: string | null
    preferredBoxName?: string | null
    text: string
    mentions: DesktopCoworkerMention[]
    onTextChange: (text: string) => void
    onMentionsChange: (mentions: DesktopCoworkerMention[]) => void
    enabled?: boolean
    refreshKey?: string
    children: (api: DesktopCoworkerMentionsApi) => ReactNode
}) {
    const suggestions = useDesktopSkillSuggestions(agentId, { enabled, refreshKey })
    const roster = useDesktopCoworkerMentionTargets(agentId, { enabled, refreshKey })
    const mention = useDesktopMentionAutocomplete({
        targets: roster.targets,
        skills: suggestions.skills,
        preferredBoxName,
        text,
        mentions,
        onTextChange,
        onMentionsChange,
    })

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing) return
        mention.textareaProps.onKeyDown(event)
        if (event.defaultPrevented) return
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
        }
    }, [mention.textareaProps])

    const revalidateSend = useCallback(async (): Promise<DesktopCoworkerMentionRevalidation> => {
        if (!agentId) return { ok: false, code: 'target', error: 'This conversation no longer has a local coworker owner.' }
        return revalidateDesktopCoworkerMentionsAtSend(agentId, text, mentions)
    }, [agentId, text, mentions])

    return children({
        inputRef: mention.inputRef,
        menu: mention.menu,
        tokens: mention.tokens,
        textareaProps: {
            ...mention.textareaProps,
            onKeyDown: handleKeyDown,
        },
        ...suggestions,
        coworkerMentions: mentions,
        targets: roster.targets,
        targetStatus: roster.status,
        targetError: roster.targetError,
        retryTargets: roster.retryTargets,
        revalidateSend,
    })
}
