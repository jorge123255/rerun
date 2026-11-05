'use client'

import { useCallback, type ChangeEvent, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from 'react'
import { useMentionAutocomplete, type MentionSkill } from '@/components/chat/MentionAutocomplete'
import type { ComposerMention } from '@/lib/chat/composer-links'
import { useDesktopSkillSuggestions, type DesktopSkillSuggestionStatus } from '@/lib/desktop/use-desktop-skill-suggestions'

export type DesktopSkillMentionsApi = {
    /** Attach to the composer textarea. React 19 passes the ref through the shared Textarea. */
    inputRef: RefObject<HTMLTextAreaElement | null>
    /** The anchored suggestion menu. Render it inside the composer's relative form, after the textarea. */
    menu: ReactNode
    /** `/slug` tokens for the current owner's shelf, for history parsing of a sent message. */
    tokens: ComposerMention[]
    /** Composed handlers: mention detection, durable draft text, IME guard and the send path. */
    textareaProps: {
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
        onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void
        onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
    }
    status: DesktopSkillSuggestionStatus
    skills: MentionSkill[]
    error: string | null
    retry: () => void
}

/**
 * Desktop port of the original hosted `/skill` suggestions, isolated from the composer. It reuses
 * the hosted `useMentionAutocomplete` with an empty agent list: `/slug` rows come from this
 * coworker's authenticated shelf, while `@` finds nothing and stays closed — coworker delegation
 * is never surfaced as a working mention. Insertion syntax, menu labels and keyboard behavior are
 * the original's; picking a row only writes `/slug ` into the draft.
 */
export function DesktopSkillMentions({ agentId, onTextChange, enabled = true, refreshKey, children }: {
    agentId: string | null
    onTextChange: (text: string) => void
    enabled?: boolean
    refreshKey?: string
    children: (api: DesktopSkillMentionsApi) => ReactNode
}) {
    const suggestions = useDesktopSkillSuggestions(agentId, { enabled, refreshKey })
    const mention = useMentionAutocomplete([], suggestions.skills, onTextChange)

    const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
        mention.textareaProps.onChange(event)
        onTextChange(event.currentTarget.value)
    }, [mention.textareaProps, onTextChange])

    const handleSelect = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => {
        mention.textareaProps.onSelect(event)
    }, [mention.textareaProps])

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
        // A composing Enter confirms the IME candidate: it must neither pick a suggestion nor send.
        if (event.nativeEvent.isComposing) return
        mention.textareaProps.onKeyDown(event)
        // The mention handler calls preventDefault when the menu is open: Enter picks before it may send.
        if (event.defaultPrevented) return
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
        }
    }, [mention.textareaProps])

    return children({
        inputRef: mention.inputRef,
        menu: mention.menu,
        tokens: mention.tokens,
        textareaProps: { onChange: handleChange, onSelect: handleSelect, onKeyDown: handleKeyDown },
        ...suggestions,
    })
}
