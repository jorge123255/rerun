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

type Trigger = '@' | '/'
type MentionState = { trigger: Trigger; query: string; start: number }

export function useDesktopMentionAutocomplete({ targets, skills, preferredBoxName, text, mentions, onDraftChange, requireCallable = true }: {
    targets: DesktopCoworkerCallTarget[]
    skills: MentionSkill[]
    preferredBoxName?: string | null
    text: string
    mentions: DesktopCoworkerMention[]
    onDraftChange: (text: string, mentions: DesktopCoworkerMention[]) => void
    requireCallable?: boolean
}) {
    const inputRef = useRef<HTMLTextAreaElement>(null)
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

    const open = mention !== null && items.length > 0
    useEffect(() => {
        setHighlight(current => Math.min(current, Math.max(0, items.length - 1)))
    }, [items.length])

    const detect = useCallback((element: HTMLTextAreaElement) => {
        const caret = element.selectionStart ?? 0
        const before = element.value.slice(0, caret)
        const match = before.match(/(^|\s)([@/])([\w-]*)$/)
        setMention(match ? { trigger: match[2] as Trigger, query: match[3], start: caret - match[3].length - 1 } : null)
        setHighlight(0)
    }, [])

    const pick = useCallback((item: DesktopMentionItem) => {
        const element = inputRef.current
        if (!element || !mention) return
        const caret = element.selectionStart ?? 0
        const currentText = element.value
        if (item.kind === 'agent') {
            const next = insertDesktopCoworkerMention(currentText, mentions, { start: mention.start, end: caret, target: item.target }, requireCallable)
            if (element.maxLength >= 0 && next.text.length > element.maxLength) return
            element.value = next.text
            const position = next.mentions.find(selected => selected.targetId === item.id && selected.start === mention.start)?.end ?? mention.start
            element.setSelectionRange(position + 1, position + 1)
            onDraftChange(next.text, next.mentions)
        } else {
            const inserted = `/${item.slug} `
            const nextText = `${currentText.slice(0, mention.start)}${inserted}${currentText.slice(caret)}`
            element.value = nextText
            element.setSelectionRange(mention.start + inserted.length, mention.start + inserted.length)
            onDraftChange(nextText, reconcileDesktopCoworkerMentions(currentText, nextText, mentions))
        }
        element.focus()
        setMention(null)
    }, [mention, mentions, onDraftChange, requireCallable])

    const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
        const element = event.currentTarget
        detect(element)
        onDraftChange(element.value, reconcileDesktopCoworkerMentions(text, element.value, mentions))
    }, [detect, mentions, onDraftChange, text])

    const onSelect = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => detect(event.currentTarget), [detect])
    const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing || !open) return
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlight(current => (current + 1) % items.length)
        } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlight(current => (current - 1 + items.length) % items.length)
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            const selected = items[highlight]
            if (selected) pick(selected)
        } else if (event.key === 'Escape') {
            event.preventDefault()
            setMention(null)
        }
    }, [open, items, highlight, pick])

    return {
        inputRef,
        menu: open ? <DesktopMentionMenu id={menuId} trigger={mention.trigger} items={items} highlight={highlight} onHover={setHighlight} onPick={pick} /> : null,
        tokens,
        textareaProps: {
            onChange, onSelect, onKeyDown,
            'aria-autocomplete': 'list' as const,
            'aria-haspopup': 'listbox' as const,
            'aria-expanded': open,
            'aria-controls': open ? menuId : undefined,
            'aria-activedescendant': open ? `${menuId}-${highlight}` : undefined,
        },
    }
}
