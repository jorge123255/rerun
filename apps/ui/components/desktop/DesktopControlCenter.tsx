'use client'

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { ControlCenterView } from '@/components/control-center/ControlCenterView'
import type { ControlRow, ControlSection } from '@/components/control-center/types'
import { useModKeyLabel } from '@/hooks/useModKeyLabel'
import { CirclePlusIcon, FocusCenterIcon, LayoutGridIcon, LockKeyholeIcon, MessageCircle, MoonIcon, RefreshCwIcon, SettingsIcon, SunIcon } from '@/lib/icons'
import { parseQuery, searchItems } from '@/lib/control-center/search'
import { buildDesktopControlCommands, useDesktopConversationSearch, useDesktopControlCenterKeys, type DesktopControlCommand, type DesktopControlCommandId } from '@/lib/desktop/control-center'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { useDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import type { DesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers.schema'
import { useDesktopControlCenterChats } from '@/lib/desktop/use-control-center-chats'
import type { DesktopOpenChat } from '@/lib/desktop/control-center-chats'
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
    workspace_settings: SettingsIcon,
    recenter_board: FocusCenterIcon,
    toggle_theme: SunIcon,
}

function pageKey(page: Page): string {
    return page.kind === 'root' ? 'root' : `coworker:${page.coworkerId}`
}

export type DesktopControlCenterProps = {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    disabled?: boolean
    initialRecent?: DesktopRecentCoworkers
    coworkers: DesktopAgentView[]
    // The coworker whose chat is open on the board, or null while the board shows.
    selectedCoworkerId: string | null
    onOpenConversation: (hit: DesktopConversationHit) => void
    onOpenCoworker?: (agentId: string) => void
    onOpenChat?: (target: DesktopOpenChat) => void
    onAddCoworker: () => void
    onModelSettings: () => void
    onBackToBoard: () => void
    onWorkspaceSettings?: () => void
    onRecenterBoard?: () => void
    onToggleTheme?: () => void
    /** Resolved appearance, including the current system theme. */
    darkTheme?: boolean
}

export function DesktopControlCenter({ open: controlledOpen, onOpenChange, disabled = false, initialRecent, coworkers, selectedCoworkerId, onOpenConversation, onOpenCoworker, onOpenChat, onAddCoworker, onModelSettings, onBackToBoard, onWorkspaceSettings, onRecenterBoard, onToggleTheme, darkTheme = false }: DesktopControlCenterProps) {
    const [internalOpen, setInternalOpen] = useState(false)
    const requestedOpen = controlledOpen ?? internalOpen
    const open = requestedOpen && !disabled
    const setOpen = useCallback((next: boolean) => {
        if (next && (disabled || isDesktopQuitting())) return
        if (controlledOpen === undefined) setInternalOpen(next)
        onOpenChange?.(next)
    }, [controlledOpen, disabled, onOpenChange])
    const [pages, setPages] = useState<Page[]>([ROOT])
    const [query, setQuery] = useState('')
    const recentState = useDesktopRecentCoworkers(initialRecent, selectedCoworkerId, coworkers.map(coworker => coworker.id))
    const recent = recentState.recentAgentIds
    const [wasOpen, setWasOpen] = useState(false)
    const [openCycle, setOpenCycle] = useState(0)
    const returnFocus = useRef<HTMLElement | null>(null)
    if (wasOpen !== open) {
        setWasOpen(open)
        if (open) {
            returnFocus.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
            setOpenCycle(value => value + 1)
            setPages([ROOT])
            setQuery('')
        }
    }

    useEffect(() => {
        if (requestedOpen && disabled) setOpen(false)
    }, [requestedOpen, disabled, setOpen])

    // The component owns its shortcut like the original: mounting it is the whole patch.
    useDesktopControlCenterKeys({ open, setOpen, conversationOpen: !!selectedCoworkerId, disabled })

    const mod = useModKeyLabel()
    const page = pages[pages.length - 1]
    const { scope, text } = parseQuery(query)
    const pageCoworker = page.kind === 'coworker' ? coworkers.find(coworker => coworker.id === page.coworkerId) : undefined

    const searchesConversations = open && (page.kind === 'coworker' ? !!pageCoworker : scope === 'all' && text.length >= MIN_CONVERSATION_QUERY)
    const search = useDesktopConversationSearch(text, searchesConversations, page.kind === 'coworker' ? page.coworkerId : null)
    const selectionScope = JSON.stringify([openCycle, pageKey(page), query])
    const showCoworkerChats = open && !!pageCoworker && query.trim() === ''
    const chats = useDesktopControlCenterChats(pageCoworker?.id ?? null, showCoworkerChats, selectionScope)
    const [chatNotice, setChatNotice] = useState<{ scope: string; text: string } | null>(null)
    const selectingChat = useRef<{ scope: string } | null>(null)
    const latest = useRef({ open, disabled, selectionScope, coworkers, search, chats, onOpenConversation, onOpenCoworker, onOpenChat, onAddCoworker, onModelSettings, onBackToBoard, onWorkspaceSettings, onRecenterBoard, onToggleTheme, darkTheme })
    latest.current = { open, disabled, selectionScope, coworkers, search, chats, onOpenConversation, onOpenCoworker, onOpenChat, onAddCoworker, onModelSettings, onBackToBoard, onWorkspaceSettings, onRecenterBoard, onToggleTheme, darkTheme }
    const available = () => latest.current.open && !latest.current.disabled && !isDesktopQuitting() && latest.current.selectionScope === selectionScope

    const close = () => {
        // Invalidate retained row callbacks immediately, before React commits the closed view.
        latest.current.open = false
        returnFocus.current = null
        setOpen(false)
    }

    const drill = (next: Page) => () => {
        if (!available() || (next.kind === 'coworker' && !latest.current.coworkers.some(coworker => coworker.id === next.coworkerId))) return
        setPages(stack => [...stack, next])
        setQuery('')
    }

    const back = () => {
        if (!available()) return
        setPages(stack => (stack.length > 1 ? stack.slice(0, -1) : stack))
        setQuery('')
    }

    const coworkerRow = (coworker: DesktopAgentView, section: string): ControlRow => ({
        id: `${section}-coworker-${coworker.id}`,
        label: coworker.name,
        detail: coworker.description || undefined,
        leading: { kind: 'agent', agentId: coworker.id },
        badge: coworker.enabled === false ? { label: 'Off', tone: 'neutral' } : undefined,
        onSelect: () => {
            if (!available() || !latest.current.coworkers.some(current => current.id === coworker.id)) return
            const action = latest.current.onOpenCoworker
            if (!action) return drill({ kind: 'coworker', coworkerId: coworker.id })()
            close()
            action(coworker.id)
        },
        onDrill: drill({ kind: 'coworker', coworkerId: coworker.id }),
    })

    const conversationSection = (section: string, heading: string, coworkerId: string | null): ControlSection[] => {
        if (search.failed) {
            return [{
                id: section,
                heading,
                rows: [{ id: `${section}-retry`, label: 'Could not search saved chats', detail: 'Try again', leading: { kind: 'icon', icon: RefreshCwIcon }, onSelect: () => { if (available()) latest.current.search.retry() } }],
            }]
        }
        const hits = search.hits.filter(hit => (!coworkerId || hit.agentId === coworkerId) && coworkers.some(coworker => coworker.id === hit.agentId))
        const rows: ControlRow[] = hits.map(hit => ({
            id: `${section}-conversation-${hit.id}`,
            label: hit.title,
            detail: coworkerId ? undefined : coworkers.find(coworker => coworker.id === hit.agentId)?.name,
            leading: { kind: 'icon', icon: MessageCircle },
            onSelect: () => {
                const current = latest.current
                if (!available() || current.search.loading || current.search.failed) return
                const liveHit = current.search.hits.find(candidate => candidate.id === hit.id && candidate.agentId === hit.agentId)
                const owner = current.coworkers.find(coworker => coworker.id === hit.agentId)
                if (!liveHit || !owner || (coworkerId && liveHit.agentId !== coworkerId)) return
                close()
                current.onOpenConversation({ ...liveHit, agentName: owner.name })
            },
        }))
        const loading = search.loading && rows.length === 0
        return rows.length > 0 || loading ? [{ id: section, heading, rows, loading }] : []
    }

    const selectCoworkerChat = async (target: { kind: 'open'; chat: DesktopOpenChat } | { kind: 'recent'; chat: DesktopConversationHit }) => {
        const ownerId = target.chat.agentId
        if (!available() || selectingChat.current?.scope === selectionScope || !latest.current.coworkers.some(coworker => coworker.id === ownerId)) return
        const shown = latest.current.chats.data
        if (shown?.agentId !== ownerId) return
        if (target.kind === 'open' ? !shown.openChats.some(chat => chat.tabUid === target.chat.tabUid && chat.sessionId === target.chat.sessionId)
            : !shown.recentChats.some(chat => chat.id === target.chat.id)) return
        const attempt = { scope: selectionScope }
        selectingChat.current = attempt
        setChatNotice(null)
        try {
            const fresh = await latest.current.chats.refresh()
            const current = latest.current
            const owner = current.coworkers.find(coworker => coworker.id === ownerId)
            if (!fresh || !available() || selectingChat.current !== attempt || !owner || fresh.agentId !== ownerId) return
            if (target.kind === 'open') {
                const found = fresh.openChats.find(chat => chat.agentId === ownerId && chat.tabUid === target.chat.tabUid && chat.sessionId === target.chat.sessionId)
                if (found && (current.onOpenChat || found.sessionId !== null)) {
                    close()
                    if (current.onOpenChat) current.onOpenChat(found)
                    else current.onOpenConversation({ id: found.sessionId!, agentId: ownerId, agentName: owner.name, title: found.title })
                    return
                }
            } else {
                const openChat = fresh.openChats.find(chat => chat.agentId === ownerId && chat.sessionId === target.chat.id)
                const found = fresh.recentStatus === 'ok' ? fresh.recentChats.find(chat => chat.agentId === ownerId && chat.id === target.chat.id) : undefined
                if (openChat || found) {
                    close()
                    if (openChat && current.onOpenChat) current.onOpenChat(openChat)
                    else current.onOpenConversation({ id: target.chat.id, agentId: ownerId, agentName: owner.name, title: openChat?.title ?? found!.title })
                    return
                }
            }
            setChatNotice({ scope: selectionScope, text: 'This chat changed. Choose it again from the refreshed list.' })
        } finally {
            if (selectingChat.current === attempt) selectingChat.current = null
        }
    }

    const coworkerChatSections = (): ControlSection[] => {
        const retry = () => { if (available()) { setChatNotice(null); void latest.current.chats.refresh() } }
        if (chats.failed) return [{ id: 'coworker-chats-error', heading: 'Chats', rows: [{
            id: 'coworker-chats-retry', label: 'Could not load chats', detail: 'Try again', leading: { kind: 'icon', icon: RefreshCwIcon }, onSelect: retry,
        }] }]
        if (!chats.data) return [{ id: 'open-chats', heading: 'Open chats', rows: [], loading: chats.loading }]
        const openRows: ControlRow[] = chats.data.openChats.map(chat => ({
            id: `open-chat-${chat.tabUid}`, label: chat.title, leading: { kind: 'icon', icon: MessageCircle },
            disabledReason: !onOpenChat && chat.sessionId === null ? 'Open this chat from the coworker panel.' : undefined,
            onSelect: () => { void selectCoworkerChat({ kind: 'open', chat }) },
        }))
        const recentRows: ControlRow[] = chats.data.recentStatus === 'unavailable' ? [{
            id: 'recent-chats-retry', label: 'Could not load recent conversations', detail: 'Try again', leading: { kind: 'icon', icon: RefreshCwIcon }, onSelect: retry,
        }] : chats.data.recentChats.map(chat => ({
            id: `recent-chat-${chat.id}`, label: chat.title, leading: { kind: 'icon', icon: MessageCircle },
            onSelect: () => { void selectCoworkerChat({ kind: 'recent', chat }) },
        }))
        return [{ id: 'open-chats', heading: 'Open chats', rows: openRows }, { id: 'recent-chats', heading: 'Recent conversations', rows: recentRows }]
    }

    const commandRow = (command: DesktopControlCommand): ControlRow => ({
        id: `command-${command.id}`,
        label: command.label,
        leading: { kind: 'icon', icon: command.id === 'toggle_theme' && !darkTheme ? MoonIcon : COMMAND_ICONS[command.id] },
        onSelect: () => {
            if (!available()) return
            const current = latest.current
            const action = {
                add_coworker: current.onAddCoworker, team_board: current.onBackToBoard, model_settings: current.onModelSettings,
                workspace_settings: current.onWorkspaceSettings, recenter_board: current.onRecenterBoard, toggle_theme: current.onToggleTheme,
            }[command.id]
            // A retained row cannot dismiss the center when its action was removed, or invoke
            // the opposite of the theme choice the user saw before the appearance changed.
            if (!action || (command.id === 'toggle_theme' && current.darkTheme !== darkTheme)) return
            close()
            action()
        },
    })

    function sections(): ControlSection[] {
        const commands = buildDesktopControlCommands({ workspaceSettings: !!onWorkspaceSettings, recenterBoard: !!onRecenterBoard, toggleTheme: !!onToggleTheme, darkTheme })
        const commandSections: ControlSection[] = [
            { id: 'actions', heading: 'Actions', rows: searchItems(commands.filter(command => command.group === 'actions'), text).map(commandRow) },
            { id: 'settings', heading: 'Settings', rows: searchItems(commands.filter(command => command.group === 'settings'), text).map(commandRow) },
        ]
        const searchableCoworkers = coworkers.map(coworker => ({ coworker, label: coworker.name, keywords: [coworker.description ?? ''] }))

        if (scope === 'commands') return commandSections
        if (scope === 'agents') return [{ id: 'coworkers', heading: 'Coworkers', rows: searchItems(searchableCoworkers, text).map(entry => coworkerRow(entry.coworker, 'coworkers')) }]

        if (page.kind === 'coworker') {
            if (!pageCoworker) return []
            if (query.trim() === '') return coworkerChatSections()
            return conversationSection('coworker-conversations', 'Conversations', page.coworkerId)
        }

        if (!text) {
            const recentIds = new Set(recent)
            const recentCoworkers = recent.map(id => coworkers.find(coworker => coworker.id === id)).filter((coworker): coworker is DesktopAgentView => !!coworker)
            const others = coworkers.filter(coworker => !recentIds.has(coworker.id)).slice(0, COWORKER_RESULTS)
            const retryRows: ControlRow[] = recentState.error ? [{
                id: 'recent-retry', label: recentState.error, detail: 'Try again', leading: { kind: 'icon', icon: RefreshCwIcon },
                onSelect: () => { if (available()) recentState.retry() },
            }] : []
            return [
                recentCoworkers.length > 0 ? { id: 'recent', heading: 'Recent', rows: [...recentCoworkers.map(coworker => coworkerRow(coworker, 'recent')), ...retryRows] } : { id: 'coworkers', heading: 'Coworkers', rows: others.map(coworker => coworkerRow(coworker, 'coworkers')) },
                ...(!recentCoworkers.length && retryRows.length ? [{ id: 'recent-save', heading: 'Recent', rows: retryRows }] : []),
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
    const emptyLabel = showCoworkerChats ? 'No open chats or recent conversations yet.' : page.kind === 'coworker' && text.length < MIN_CONVERSATION_QUERY
        ? 'Type at least 2 characters to search this coworker’s saved chats.'
        : 'Nothing matches.'

    return (
        <ControlCenterView
            open={open}
            onOpenChange={setOpen}
            anchorToOrb={false}
            description="Jump to a coworker, model settings or a saved conversation."
            closeHint="to close"
            resultsHint={showCoworkerChats
                ? chatNotice?.scope === selectionScope ? chatNotice.text : chats.loading && chats.data ? 'Refreshing chats…' : chats.data?.hasMore ? 'Showing 8 recent conversations. Type to search older chats.' : undefined
                : search.hasMore ? 'Showing the first 50 matches. Refine your search for more.' : undefined}
            onCloseAutoFocus={event => {
                event.preventDefault()
                if (latest.current.open) return
                const target = returnFocus.current
                returnFocus.current = null
                const closedScope = latest.current.selectionScope
                const closingDialog = event.target instanceof HTMLElement ? event.target : null
                // Radix finishes removing its focus scope after this callback. Its temporary
                // aria-hidden markers must not stop us returning to the original composer.
                queueMicrotask(() => {
                    const current = latest.current
                    if (!target?.isConnected || current.open || current.disabled || current.selectionScope !== closedScope || isDesktopQuitting() || target.closest('[inert]')) return
                    const modal = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].find(element => element !== closingDialog && element.getAttribute('data-state') !== 'closed')
                    if (modal && !modal.contains(target)) return
                    const active = document.activeElement
                    if (active && active !== document.body && active !== target && !closingDialog?.contains(active)) return
                    target.focus({ preventScroll: true })
                })
            }}
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
