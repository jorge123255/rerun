'use client'

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type SyntheticEvent } from 'react'
import { mentionTokensOf, type MentionSkill } from '@/components/chat/MentionAutocomplete'
import type { ComposerMention } from '@/lib/chat/composer-links'
import {
    insertDesktopCoworkerMention,
    reconcileDesktopCoworkerMentions,
    type DesktopCoworkerMention,
} from '@/lib/desktop/coworker-mentions'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import { DesktopMentionMenu, type DesktopMentionItem } from './DesktopMentionMenu'

type Trigger = '@' | '/'
type MentionState = { trigger: Trigger; query: string; start: number }

export function useDesktopMentionAutocomplete({ targets, skills, preferredBoxName, text, mentions, onTextChange, onMentionsChange }: {
    targets: DesktopCoworkerCallTarget[]
    skills: MentionSkill[]
    preferredBoxName?: string | null
    text: string
    mentions: DesktopCoworkerMention[]
    onTextChange: (text: string) => void
    onMentionsChange: (mentions: DesktopCoworkerMention[]) => void
}) {
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const [mention, setMention] = useState<MentionState | null>(null)
    const [highlight, setHighlight] = useState(0)

    const agents = useMemo(() => targets
        .filter(target => target.enabled && target.callable)
        .map(target => ({
            kind: 'agent' as const,
            target,
            id: target.agentId,
            name: target.name,
            handle: target.handle,
            hint: target.boxName ?? '',
            preferred: preferredBoxName !== null && preferredBoxName !== undefined && target.boxName === preferredBoxName,
        })), [targets, preferredBoxName])

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
            const next = insertDesktopCoworkerMention(currentText, mentions, { start: mention.start, end: caret, target: item.target })
            element.value = next.text
            const position = next.mentions.find(selected => selected.targetId === item.id && selected.start === mention.start)?.end ?? mention.start
            element.setSelectionRange(position + 1, position + 1)
            onMentionsChange(next.mentions)
            onTextChange(next.text)
        } else {
            const inserted = `/${item.slug} `
            const nextText = `${currentText.slice(0, mention.start)}${inserted}${currentText.slice(caret)}`
            element.value = nextText
            element.setSelectionRange(mention.start + inserted.length, mention.start + inserted.length)
            onMentionsChange(reconcileDesktopCoworkerMentions(currentText, nextText, mentions))
            onTextChange(nextText)
        }
        element.focus()
        setMention(null)
    }, [mention, mentions, onMentionsChange, onTextChange])

    const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
        const element = event.currentTarget
        detect(element)
        onMentionsChange(reconcileDesktopCoworkerMentions(text, element.value, mentions))
        onTextChange(element.value)
    }, [detect, mentions, onMentionsChange, onTextChange, text])

    const onSelect = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => detect(event.currentTarget), [detect])
    const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!open) return
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlight(current => (current + 1) % items.length)
        } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlight(current => (current - 1 + items.length) % items.length)
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            pick(items[highlight])
        } else if (event.key === 'Escape') {
            event.preventDefault()
            setMention(null)
        }
    }, [open, items, highlight, pick])

    return {
        inputRef,
        menu: open ? <DesktopMentionMenu trigger={mention.trigger} items={items} highlight={highlight} onHover={setHighlight} onPick={pick} /> : null,
        tokens,
        textareaProps: { onChange, onSelect, onKeyDown },
    }
}
