'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type SyntheticEvent } from 'react'
import { mentionTokensOf, type MentionSkill } from '@/components/chat/MentionAutocomplete'
import type { ComposerMention } from '@/lib/chat/composer-links'
import {
    canMentionDesktopCoworker,
    insertDesktopCoworkerMention,
    reconcileDesktopCoworkerMentions,
    type DesktopCoworkerMention,
} from '@/lib/desktop/coworker-mentions'
import type { DesktopCoworkerCallTarget } from '@rerun/contracts'
import { DesktopMentionMenu, type DesktopMentionItem } from './DesktopMentionMenu'
import { useDesktopComposerLinks } from './useDesktopComposerLinks'

type Trigger = '@' | '/'
type MentionState = { trigger: Trigger; query: string; start: number; scope?: string }

export function useDesktopMentionAutocomplete({ targets, skills, preferredBoxName, text, mentions, onDraftChange, scope, requireCallable = true }: {
    targets: DesktopCoworkerCallTarget[]
    skills: MentionSkill[]
    preferredBoxName?: string | null
    text: string
    mentions: DesktopCoworkerMention[]
    onDraftChange: (text: string, mentions: DesktopCoworkerMention[]) => void
    requireCallable?: boolean
    scope?: string
}) {
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const links = useDesktopComposerLinks(text, inputRef, scope)
    const menuId = useId()
    const [mention, setMention] = useState<MentionState | null>(null)
    const [highlight, setHighlight] = useState(0)

    const agents = useMemo(() => targets
        .filter(target => canMentionDesktopCoworker(target, requireCallable))
        .map(target => ({
            kind: 'agent' as const,
            target,
            id: target.agentId,
            name: target.name,
            handle: target.handle,
            hint: target.boxName ?? '',
            preferred: preferredBoxName !== null && preferredBoxName !== undefined && target.boxName === preferredBoxName,
        })), [targets, preferredBoxName, requireCallable])

    const items = useMemo<DesktopMentionItem[]>(() => {
        if (!mention) return []
        const query = mention.query.toLowerCase()
        if (mention.trigger === '/') return skills
            .filter(skill => skill.name.toLowerCase().includes(query) || skill.slug.toLowerCase().includes(query))
            .map(skill => ({ kind: 'skill' as const, ...skill }))
            .sort((a, b) => a.name.localeCompare(b.name))
        return agents
            .filter(agent => [agent.name, agent.handle ?? '', agent.hint].some(field => field.toLowerCase().includes(query)))
            .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name))
    }, [agents, skills, mention])

    const tokens = useMemo<ComposerMention[]>(() => {
        const current = mentionTokensOf(agents, skills)
        for (const selected of mentions) {
            if (!current.some(token => token.text === selected.token)) current.push({ text: selected.token, kind: 'agent' })
        }
        return current
    }, [agents, skills, mentions])

    const open = mention !== null && mention.scope === scope && items.length > 0
    useEffect(() => {
        setHighlight(current => Math.min(current, Math.max(0, items.length - 1)))
    }, [items.length])

    const detect = useCallback((element: HTMLTextAreaElement) => {
        const caret = element.selectionStart ?? 0
        const before = element.value.slice(0, caret)
        const match = before.match(/(^|\s)([@/])([\w-]*)$/)
        setMention(match ? { trigger: match[2] as Trigger, query: match[3], start: caret - match[3].length - 1, scope } : null)
        setHighlight(0)
    }, [scope])

    const pick = (item: DesktopMentionItem) => {
        const element = inputRef.current
        if (!element || !mention || element.disabled || element.readOnly) return
        const displayCaret = element.selectionStart
        const before = element.value.slice(0, displayCaret)
        if (before.slice(mention.start) !== mention.trigger + mention.query) return
        const caret = links.expand(before).length
        const start = links.expand(before.slice(0, mention.start)).length
        const currentText = links.expand(element.value)
        let draft: string, selected: DesktopCoworkerMention[]
        if (item.kind === 'agent') {
            const next = insertDesktopCoworkerMention(currentText, mentions, { start, end: caret, target: item.target }, requireCallable)
            draft = next.text
            selected = next.mentions
        } else {
            draft = `${currentText.slice(0, start)}/${item.slug} ${currentText.slice(caret)}`
            selected = reconcileDesktopCoworkerMentions(currentText, draft, mentions)
        }
        if (element.maxLength >= 0 && draft.length > element.maxLength) return
        const extraSpace = item.kind === 'agent' && element.value[displayCaret] === ' ' ? 1 : 0
        const inserted = draft.slice(start, draft.length - (currentText.length - caret - extraSpace))
        element.setRangeText(inserted, mention.start, displayCaret + extraSpace, 'end')
        links.record(element.value, draft)
        onDraftChange(draft, selected)
        element.focus()
        setMention(null)
    }

    const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
        const element = event.currentTarget
        const source = links.accept(element)
        if (source === null) return
        detect(element)
        onDraftChange(source, reconcileDesktopCoworkerMentions(text, source, mentions))
    }

    const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
        links.handlers.onSelect(event)
        detect(event.currentTarget)
    }
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing || event.currentTarget.disabled || event.currentTarget.readOnly) return
        if (open && event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlight(current => (current + 1) % items.length)
        } else if (open && event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlight(current => (current - 1 + items.length) % items.length)
        } else if (open && (event.key === 'Enter' || event.key === 'Tab')) {
            event.preventDefault()
            const selected = items[highlight]
            if (selected) pick(selected)
        } else if (open && event.key === 'Escape') {
            event.preventDefault()
            setMention(null)
        }
        if (!event.defaultPrevented) links.handlers.onKeyDown(event)
    }

    return {
        inputRef,
        menu: open ? <DesktopMentionMenu id={menuId} trigger={mention.trigger} items={items} highlight={highlight} onHover={setHighlight} onPick={pick} /> : null,
        tokens,
        linkMirror: links.mirror,
        textareaProps: {
            ...links.handlers,
            value: links.value,
            onChange, onSelect, onKeyDown,
            'aria-autocomplete': 'list' as const,
            'aria-haspopup': 'listbox' as const,
            'aria-expanded': open,
            'aria-controls': open ? menuId : undefined,
            'aria-activedescendant': open ? `${menuId}-${highlight}` : undefined,
        },
    }
}
