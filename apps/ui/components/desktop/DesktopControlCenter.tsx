'use client'

import { useEffect, useState, type ComponentType } from 'react'
import { ControlCenterView } from '@/components/control-center/ControlCenterView'
import type { ControlRow, ControlSection } from '@/components/control-center/types'
import { useModKeyLabel } from '@/hooks/useModKeyLabel'
import { CirclePlusIcon, LayoutGridIcon, LockKeyholeIcon, MessageCircle, RefreshCwIcon } from '@/lib/icons'
import { parseQuery, searchItems } from '@/lib/control-center/search'
import { buildDesktopControlCommands, pushRecentCoworker, useDesktopConversationSearch, useDesktopControlCenterKeys, type DesktopControlCommand, type DesktopControlCommandId } from '@/lib/desktop/control-center'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import type { DesktopAgentView } from './DesktopApp'

type Page = { kind: 'root' } | { kind: 'coworker'; coworkerId: string }

const ROOT: Page = { kind: 'root' }

const COWORKER_RESULTS = 8
const MIN_CONVERSATION_QUERY = 2

// Only the actions the Mac app already supports; anything without a real callback stays out.
const COMMAND_ICONS: Record<DesktopControlCommandId, ComponentType<{ className?: string }>> = {
    add_coworker: CirclePlusIcon,
    team_board: LayoutGridIcon,
    model_settings: LockKeyholeIcon,
}

function pageKey(page: Page): string {
    return page.kind === 'root' ? 'root' : `coworker:${page.coworkerId}`
}

export type DesktopControlCenterProps = {
    coworkers: DesktopAgentView[]
    // The coworker whose chat is open on the board, or null while the board shows.
    selectedCoworkerId: string | null
    onOpenConversation: (hit: DesktopConversationHit) => void
    onAddCoworker: () => void
    onModelSettings: () => void
    onBackToBoard: () => void
}

export function DesktopControlCenter({ coworkers, selectedCoworkerId, onOpenConversation, onAddCoworker, onModelSettings, onBackToBoard }: DesktopControlCenterProps) {
    const [open, setOpen] = useState(false)
    const [pages, setPages] = useState<Page[]>([ROOT])
    const [query, setQuery] = useState('')
    const [recent, setRecent] = useState<string[]>([])
    const [wasOpen, setWasOpen] = useState(open)
    if (wasOpen !== open) {
        setWasOpen(open)
        if (open) {
            setPages([ROOT])
            setQuery('')
        }
    }

    // The component owns its shortcut like the original: mounting it is the whole patch.
    useDesktopControlCenterKeys({ open, setOpen, conversationOpen: !!selectedCoworkerId })

    useEffect(() => {
        if (selectedCoworkerId) setRecent(current => pushRecentCoworker(current, selectedCoworkerId))
    }, [selectedCoworkerId])

    const mod = useModKeyLabel()
    const page = pages[pages.length - 1]
    const { scope, text } = parseQuery(query)
    const pageCoworker = page.kind === 'coworker' ? coworkers.find(coworker => coworker.id === page.coworkerId) : undefined

    const searchesConversations = open && (page.kind === 'coworker' || (page.kind === 'root' && scope === 'all' && text.length >= MIN_CONVERSATION_QUERY))
    const search = useDesktopConversationSearch(text, searchesConversations)

    const close = (action: () => void) => () => {
        setOpen(false)
        action()
    }

    const drill = (next: Page) => () => {
        setPages(stack => [...stack, next])
        setQuery('')
    }

    const back = () => {
        setPages(stack => (stack.length > 1 ? stack.slice(0, -1) : stack))
        setQuery('')
    }

    const coworkerRow = (coworker: DesktopAgentView, section: string): ControlRow => ({
        id: `${section}-coworker-${coworker.id}`,
        label: coworker.name,
        detail: coworker.description || undefined,
        leading: { kind: 'agent', agentId: coworker.id },
        badge: coworker.enabled === false ? { label: 'Off', tone: 'neutral' } : undefined,
        // Opening the coworker's chat belongs to the board tile; the center only drills in.
        onSelect: drill({ kind: 'coworker', coworkerId: coworker.id }),
        onDrill: drill({ kind: 'coworker', coworkerId: coworker.id }),
    })

    const conversationSection = (section: string, heading: string, coworkerId: string | null): ControlSection[] => {
        if (search.failed) {
            return [{
                id: section,
                heading,
                rows: [{ id: `${section}-retry`, label: 'Could not search saved chats', detail: 'Try again', leading: { kind: 'icon', icon: RefreshCwIcon }, onSelect: search.retry }],
            }]
        }
        const hits = coworkerId ? search.hits.filter(hit => hit.agentId === coworkerId) : search.hits
        const rows: ControlRow[] = hits.map(hit => ({
            id: `${section}-conversation-${hit.id}`,
            label: hit.title,
            detail: coworkerId ? undefined : coworkers.find(coworker => coworker.id === hit.agentId)?.name,
            leading: { kind: 'icon', icon: MessageCircle },
            onSelect: close(() => onOpenConversation(hit)),
        }))
        const loading = search.loading && rows.length === 0
        return rows.length > 0 || loading ? [{ id: section, heading, rows, loading }] : []
    }

    const commandActions: Record<DesktopControlCommandId, () => void> = {
        add_coworker: onAddCoworker,
        team_board: onBackToBoard,
        model_settings: onModelSettings,
    }

    const commandRow = (command: DesktopControlCommand): ControlRow => ({
        id: `command-${command.id}`,
        label: command.label,
        leading: { kind: 'icon', icon: COMMAND_ICONS[command.id] },
        onSelect: close(commandActions[command.id]),
    })

    function sections(): ControlSection[] {
        const commands = buildDesktopControlCommands()
        const commandSections: ControlSection[] = [
            { id: 'actions', heading: 'Actions', rows: searchItems(commands.filter(command => command.group === 'actions'), text).map(commandRow) },
            { id: 'settings', heading: 'Settings', rows: searchItems(commands.filter(command => command.group === 'settings'), text).map(commandRow) },
        ]
        const searchableCoworkers = coworkers.map(coworker => ({ coworker, label: coworker.name, keywords: [coworker.description ?? ''] }))

        if (scope === 'commands') return commandSections
        if (scope === 'agents') return [{ id: 'coworkers', heading: 'Coworkers', rows: searchItems(searchableCoworkers, text).map(entry => coworkerRow(entry.coworker, 'coworkers')) }]

        if (page.kind === 'coworker') {
            if (!pageCoworker) return []
            return conversationSection('coworker-conversations', 'Conversations', page.coworkerId)
        }

        if (!text) {
            const recentIds = new Set(recent)
            const recentCoworkers = recent.map(id => coworkers.find(coworker => coworker.id === id)).filter((coworker): coworker is DesktopAgentView => !!coworker)
            const others = coworkers.filter(coworker => !recentIds.has(coworker.id)).slice(0, COWORKER_RESULTS)
            return [
                recentCoworkers.length > 0 ? { id: 'recent', heading: 'Recent', rows: recentCoworkers.map(coworker => coworkerRow(coworker, 'recent')) } : { id: 'coworkers', heading: 'Coworkers', rows: others.map(coworker => coworkerRow(coworker, 'coworkers')) },
                ...commandSections,
            ]
        }

        return [
            { id: 'coworkers', heading: 'Coworkers', rows: searchItems(searchableCoworkers, text, COWORKER_RESULTS).map(entry => coworkerRow(entry.coworker, 'coworkers')) },
            ...commandSections,
            ...conversationSection('conversations', 'Conversations', null),
        ]
    }

    const crumbs = page.kind === 'coworker' ? [pageCoworker?.name ?? ''] : []
    const placeholder = page.kind === 'coworker' ? `Search in ${pageCoworker?.name ?? 'this coworker'}…` : 'Search coworkers, settings, conversations…'
    const emptyLabel = page.kind === 'coworker' && text.length < MIN_CONVERSATION_QUERY
        ? 'Type at least 2 characters to search this coworker’s saved chats.'
        : 'Nothing matches.'

    return (
        <ControlCenterView
            open={open}
            onOpenChange={setOpen}
            anchorToOrb={false}
            query={query}
            onQueryChange={setQuery}
            placeholder={placeholder}
            pageKey={pageKey(page)}
            depth={pages.length - 1}
            crumbs={crumbs}
            onBack={back}
            sections={sections().filter(section => section.rows.length > 0 || section.loading)}
            emptyLabel={emptyLabel}
            mod={mod}
        />
    )
}
