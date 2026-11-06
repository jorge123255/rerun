'use client'

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { DesktopControlCenterParityView } from './control-center-parity/DesktopControlCenterParityView'
import { useDesktopControlParity, type DesktopParityCallbacks } from './control-center-parity/useDesktopControlParity'
import type { ControlRow, ControlSection } from '@/components/control-center/types'
import { useModKeyLabel } from '@/hooks/useModKeyLabel'
import { BrainIcon, BellIcon, FolderIcon, BoxIcon, CirclePlusIcon, FocusCenterIcon, KeyboardIcon, LayoutGridIcon, LockKeyholeIcon, MessageCircle, MoonIcon, RefreshCwIcon, SettingsIcon, SunIcon } from '@/lib/icons'
import { parseQuery, searchItems } from '@/lib/control-center/search'
import { buildDesktopControlCommands, buildDesktopControlCoworkerTabs, useDesktopConversationSearch, useDesktopControlCenterKeys, type DesktopControlCommand, type DesktopControlCommandId } from '@/lib/desktop/control-center'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { latestBoardAttention, type BoardActivitySnapshot } from '@/lib/desktop/board-activity'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { useDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import type { DesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers.schema'
import { useDesktopControlCenterChats } from '@/lib/desktop/use-control-center-chats'
import type { DesktopOpenChat } from '@/lib/desktop/control-center-chats'
import type { DesktopCoworkerPanel } from '@/lib/desktop/coworker-panel'
import type { DesktopAgentView } from './DesktopApp'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { firstDesktopSpacePosition } from './desktop-space-layout'

type Page = { kind: 'root' } | { kind: 'coworker'; coworkerId: string } | { kind: 'box'; spaceId: string } | { kind: 'move'; coworkerId: string }

const ROOT: Page = { kind: 'root' }

const COWORKER_RESULTS = 8
const BOX_RESULTS = 5
const MIN_CONVERSATION_QUERY = 2

// Only the actions the Mac app already supports; anything without a real callback stays out.
const COMMAND_ICONS: Record<DesktopControlCommandId, ComponentType<{ className?: string }>> = {
    add_coworker: CirclePlusIcon,
    new_box: BoxIcon,
    shared_files: FolderIcon,
    company_brain: BrainIcon,
    team_board: LayoutGridIcon,
    model_settings: LockKeyholeIcon,
    workspace_settings: SettingsIcon,
    recenter_board: FocusCenterIcon,
    toggle_theme: SunIcon,
    shortcuts: KeyboardIcon,
    notifications: BellIcon,
}

function pageKey(page: Page): string {
    return page.kind === 'root' ? 'root' : page.kind === 'box' ? `box:${page.spaceId}` : `${page.kind}:${page.coworkerId}`
}

export type DesktopControlCenterProps = DesktopParityCallbacks & {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    disabled?: boolean
    initialRecent?: DesktopRecentCoworkers
    activity?: BoardActivitySnapshot
    onRefreshActivity?: () => Promise<BoardActivitySnapshot | null>
    coworkers: DesktopAgentView[]
    board?: DesktopBoardState
    onSharedFiles?: () => void
    onBrain?: () => void
    onAddBox?: () => void
    onMoveCoworker?: (agentId: string, spaceId: string) => void
    // The coworker whose chat is open on the board, or null while the board shows.
    selectedCoworkerId: string | null
    onOpenConversation: (hit: DesktopConversationHit) => void
    onOpenCoworker?: (agentId: string) => void
    onOpenCoworkerPanel?: (agentId: string, panel: DesktopCoworkerPanel) => void
    onOpenCoworkerSetup?: (agentId: string) => void
    onOpenChat?: (target: DesktopOpenChat) => void
    onAddCoworker: () => void
    onModelSettings: () => void
    onBackToBoard: () => void
    onShortcuts?: () => void
    onNotifications?: (agentId?: string) => void
    onWorkspaceSettings?: () => void
    onRecenterBoard?: () => void
    onToggleTheme?: () => void
    /** Resolved appearance, including the current system theme. */
    darkTheme?: boolean
}

export function DesktopControlCenter({ onTemplates, onExternalMcp, onServers, runtimeWorkspaceId, onOpenDesktop, onAskAssistant, open: controlledOpen, onOpenChange, disabled = false, initialRecent, activity, onRefreshActivity, coworkers, board, onSharedFiles, onBrain, onAddBox, onMoveCoworker, selectedCoworkerId, onOpenConversation, onOpenCoworker, onOpenCoworkerPanel, onOpenCoworkerSetup, onOpenChat, onAddCoworker, onModelSettings, onBackToBoard, onShortcuts, onNotifications, onWorkspaceSettings, onRecenterBoard, onToggleTheme, darkTheme = false }: DesktopControlCenterProps) {
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
    const pageCoworker = page.kind === 'coworker' || page.kind === 'move' ? coworkers.find(coworker => coworker.id === page.coworkerId) : undefined
    const pageSpace = page.kind === 'box' ? board?.spaces.find(space => space.id === page.spaceId) : undefined
    const membership = (coworkerId: string) => board?.placements.find(placed => placed.agentId === coworkerId)?.spaceId
    const boxName = (spaceId: string | undefined) => board?.spaces.find(space => space.id === spaceId)?.name

    const searchesConversations = open && (page.kind === 'coworker' ? !!pageCoworker : page.kind === 'root' && scope === 'all' && text.length >= MIN_CONVERSATION_QUERY)
    const search = useDesktopConversationSearch(text, searchesConversations, page.kind === 'coworker' ? page.coworkerId : null)
    const selectionScope = JSON.stringify([openCycle, pageKey(page), query])
    const showCoworkerChats = open && page.kind === 'coworker' && !!pageCoworker && query.trim() === ''
    const chats = useDesktopControlCenterChats(pageCoworker?.id ?? null, showCoworkerChats, selectionScope)
    const [chatNotice, setChatNotice] = useState<{ scope: string; text: string } | null>(null)
    const [attentionNotice, setAttentionNotice] = useState<{ scope: string; text: string } | null>(null)
    const selectingAttention = useRef<{ scope: string } | null>(null)
    const selectingChat = useRef<{ scope: string } | null>(null)
    const latest = useRef({ open, disabled, selectionScope, coworkers, board, onSharedFiles, onBrain, onAddBox, onMoveCoworker, activity, onRefreshActivity, search, chats, onOpenConversation, onOpenCoworker, onOpenCoworkerPanel, onOpenCoworkerSetup, onOpenChat, onAddCoworker, onModelSettings, onBackToBoard, onShortcuts, onNotifications, onWorkspaceSettings, onRecenterBoard, onToggleTheme, darkTheme })
    latest.current = { open, disabled, selectionScope, coworkers, board, onSharedFiles, onBrain, onAddBox, onMoveCoworker, activity, onRefreshActivity, search, chats, onOpenConversation, onOpenCoworker, onOpenCoworkerPanel, onOpenCoworkerSetup, onOpenChat, onAddCoworker, onModelSettings, onBackToBoard, onShortcuts, onNotifications, onWorkspaceSettings, onRecenterBoard, onToggleTheme, darkTheme }
    const available = () => latest.current.open && !latest.current.disabled && !isDesktopQuitting() && latest.current.selectionScope === selectionScope
    const sameBoard = () => !!board && latest.current.board?.revision === board.revision

    const close = () => {
        // Invalidate retained row callbacks immediately, before React commits the closed view.
        latest.current.open = false
        returnFocus.current = null
        setOpen(false)
    }

    const parity = useDesktopControlParity({ open, scope: selectionScope, page: page.kind === 'coworker' || page.kind === 'move' ? { kind: page.kind, agentId: page.coworkerId } : page, query, agents: coworkers, board, disabled, darkTheme, close, onTemplates, onExternalMcp, onServers, runtimeWorkspaceId, onOpenDesktop, onAskAssistant })

    const drill = (next: Page) => () => {
        const current = latest.current
        if (!available()) return
        if (next.kind === 'box' && (!sameBoard() || !current.board?.spaces.some(space => space.id === next.spaceId))) return
        if ((next.kind === 'coworker' || next.kind === 'move') && !current.coworkers.some(coworker => coworker.id === next.coworkerId)) return
        if (next.kind === 'move' && (!sameBoard() || !current.onMoveCoworker || !membership(next.coworkerId)
            || current.board?.placements.find(placed => placed.agentId === next.coworkerId)?.spaceId !== membership(next.coworkerId))) return
        setPages(stack => [...stack, next])
        setQuery('')
    }

    const back = () => {
        if (!available()) return
        setPages(stack => (stack.length > 1 ? stack.slice(0, -1) : stack))
        setQuery('')
    }

    const coworkerBadge = (coworker: DesktopAgentView): ControlRow['badge'] => {
        if (coworker.enabled === false) return { label: 'Off', tone: 'neutral' }
        switch (activity?.statuses[coworker.id]) {
            case 'waiting_human': return { label: 'Needs you', tone: 'orange' }
            case 'working': return { label: 'Working', tone: 'cyan' }
            case 'unreachable': return { label: 'Activity unavailable', tone: 'neutral' }
        }
    }

    const coworkerRow = (coworker: DesktopAgentView, section: string): ControlRow => {
        const stillInBox = () => {
            if (page.kind !== 'box') return true
            const live = latest.current.board
            return sameBoard() && !!live?.spaces.some(space => space.id === page.spaceId)
                && live.placements.some(placed => placed.agentId === coworker.id && placed.spaceId === page.spaceId)
        }
        return {
            id: `${section}-coworker-${coworker.id}`,
            label: coworker.name,
            detail: boxName(membership(coworker.id)) ?? (coworker.description || undefined),
            leading: { kind: 'agent', agentId: coworker.id },
            badge: coworkerBadge(coworker),
            onSelect: () => {
                if (!available() || !stillInBox() || !latest.current.coworkers.some(current => current.id === coworker.id)) return
                const action = latest.current.onOpenCoworker
                if (!action) return drill({ kind: 'coworker', coworkerId: coworker.id })()
                close()
                action(coworker.id)
            },
            onDrill: () => { if (stillInBox()) drill({ kind: 'coworker', coworkerId: coworker.id })() },
        }
    }

    const attentionRow = (coworker: DesktopAgentView): ControlRow => {
        const target = latestBoardAttention(activity!.attention, coworker.id)!
        const stillPending = (snapshot: BoardActivitySnapshot | undefined) => {
            const owner = latest.current.coworkers.find(current => current.id === coworker.id)
            if (!owner || owner.enabled === false || snapshot?.statuses[coworker.id] !== 'waiting_human') return false
            const current = latestBoardAttention(snapshot.attention, coworker.id)
            return current?.id === target.id && current.kind === target.kind && current.sessionId === target.sessionId && current.agentEnabled !== false
        }
        return { ...coworkerRow(coworker, 'needs-you'), onSelect: () => {
            if (!available() || selectingAttention.current?.scope === selectionScope || !stillPending(latest.current.activity)) return
            const attempt = { scope: selectionScope }
            selectingAttention.current = attempt
            setAttentionNotice(null)
            void (async () => {
                try {
                    const current = latest.current
                    const fresh = current.onRefreshActivity ? await current.onRefreshActivity() : current.activity
                    if (!available() || selectingAttention.current !== attempt) return
                    if (!fresh || !stillPending(fresh) || !stillPending(latest.current.activity)) {
                        setAttentionNotice({ scope: selectionScope, text: fresh ? 'This request changed. Choose from the refreshed list.' : 'Could not check this request. Try again.' })
                        return
                    }
                    const owner = latest.current.coworkers.find(current => current.id === coworker.id)!
                    const confirmed = latestBoardAttention(fresh.attention, owner.id)!
                    close()
                    latest.current.onOpenConversation({ id: confirmed.sessionId, agentId: owner.id, agentName: owner.name, title: confirmed.title })
                } catch {
                    if (available()) setAttentionNotice({ scope: selectionScope, text: 'Could not check this request. Try again.' })
                } finally {
                    if (selectingAttention.current === attempt) selectingAttention.current = null
                }
            })()
        } }
    }

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
                new_box: current.onAddBox, shared_files: current.onSharedFiles, company_brain: current.onBrain,
                shortcuts: current.onShortcuts, notifications: current.onNotifications, workspace_settings: current.onWorkspaceSettings, recenter_board: current.onRecenterBoard, toggle_theme: current.onToggleTheme,
            }[command.id]
            // A retained row cannot dismiss the center when its action was removed, or invoke
            // the opposite of the theme choice the user saw before the appearance changed.
            if (!action || (command.id === 'new_box' && !sameBoard()) || (command.id === 'toggle_theme' && current.darkTheme !== darkTheme)) return
            close()
            action()
        },
    })

    const coworkerPanelSection = (coworkerId: string): ControlSection[] => onOpenCoworkerPanel || onOpenCoworkerSetup ? [{
        id: 'coworker-open', heading: 'Open',
        rows: searchItems(buildDesktopControlCoworkerTabs({ panels: !!onOpenCoworkerPanel, setup: !!onOpenCoworkerSetup,
            actions: !!onRefreshActivity && activity?.statuses[coworkerId] === 'waiting_human' && !!latestBoardAttention(activity.attention, coworkerId) }), text).map(tab => ({
            id: `tab-${tab.id}`, label: tab.label, detail: tab.description,
            leading: { kind: 'icon', icon: tab.icon },
            onSelect: () => {
                const current = latest.current
                if (!available() || !current.coworkers.some(owner => owner.id === coworkerId)) return
                if (tab.id === 'setup') {
                    const action = current.onOpenCoworkerSetup
                    if (!action) return
                    close()
                    action(coworkerId)
                    return
                }
                if (!current.onOpenCoworkerPanel) return
                if (tab.id === 'actions') {
                    if (!current.onRefreshActivity || selectingAttention.current?.scope === selectionScope) return
                    const attempt = { scope: selectionScope }
                    selectingAttention.current = attempt
                    void (async () => {
                        try {
                            const fresh = await current.onRefreshActivity!()
                            if (!available() || selectingAttention.current !== attempt) return
                            if (!fresh || fresh.statuses[coworkerId] !== 'waiting_human' || !latestBoardAttention(fresh.attention, coworkerId)) {
                                setAttentionNotice({ scope: selectionScope, text: fresh ? 'Nothing is waiting for this coworker now.' : 'Could not check pending requests. Try again.' })
                                return
                            }
                            const now = latest.current
                            if (!now.onOpenCoworkerPanel || !now.coworkers.some(owner => owner.id === coworkerId)) return
                            close()
                            now.onOpenCoworkerPanel(coworkerId, 'actions')
                        } catch { if (available()) setAttentionNotice({ scope: selectionScope, text: 'Could not check pending requests. Try again.' }) }
                        finally { if (selectingAttention.current === attempt) selectingAttention.current = null }
                    })()
                    return
                }
                const action = current.onOpenCoworkerPanel
                close()
                action(coworkerId, tab.id)
            },
        })),
    }] : []

    const coworkerActionsSection = (coworkerId: string): ControlSection[] => {
        const rows: (ControlRow & { keywords?: string[] })[] = []
        const spaceId = membership(coworkerId)
        if (board && board.spaces.length > 1 && spaceId && onMoveCoworker) {
            const enter = drill({ kind: 'move', coworkerId })
            rows.push({ id: 'coworker-move', label: 'Move to another Box', detail: boxName(spaceId), keywords: ['box', 'team'],
                leading: { kind: 'icon', icon: BoxIcon }, onSelect: enter, onDrill: enter })
        }
        if (onNotifications) rows.push({
            id: 'coworker-notifications', label: 'Notifications', detail: 'When this agent reaches you', keywords: ['alerts'],
            leading: { kind: 'icon', icon: BellIcon }, onSelect: () => {
                const current = latest.current
                if (!available() || !current.onNotifications || !current.coworkers.some(owner => owner.id === coworkerId)) return
                const action = current.onNotifications
                close()
                action(coworkerId)
            },
        })
        return rows.length ? [{ id: 'coworker-actions', heading: 'Actions', rows: searchItems(rows, text) }] : []
    }

    const moveSections = (coworkerId: string): ControlSection[] => {
        const sourceId = membership(coworkerId)
        if (!board || !sourceId || !pageCoworker || !onMoveCoworker) return []
        return [{ id: 'move', heading: 'Move to', rows: searchItems(board.spaces.filter(space => space.id !== sourceId)
            .map(space => ({ space, label: space.name })), text).map(({ space, label }): ControlRow => ({
            id: `move-${space.id}`, label, leading: { kind: 'icon', icon: BoxIcon },
            disabledReason: firstDesktopSpacePosition(board, space.id, coworkerId) ? null : 'This Box has no free spot for a coworker.',
            onSelect: () => {
                const current = latest.current
                const live = current.board
                if (!available() || !sameBoard() || !live || !current.onMoveCoworker || !current.coworkers.some(owner => owner.id === coworkerId)
                    || live.placements.find(placed => placed.agentId === coworkerId)?.spaceId !== sourceId
                    || !live.spaces.some(target => target.id === space.id) || !firstDesktopSpacePosition(live, space.id, coworkerId)) return
                close()
                current.onMoveCoworker(coworkerId, space.id)
            },
        })) }]
    }

    function sections(): ControlSection[] {
        if (page.kind === 'box') {
            if (!pageSpace) return []
            return [{ id: 'box-coworkers', heading: 'Coworkers', rows: searchItems(coworkers.filter(coworker => membership(coworker.id) === page.spaceId)
                .map(coworker => ({ coworker, label: coworker.name, keywords: [coworker.description] })), text).map(entry => coworkerRow(entry.coworker, 'box')) }]
        }
        if (page.kind === 'move') return moveSections(page.coworkerId)
        // A drill stays scoped to its coworker even when its query starts with / or @. Those
        // prefixes cannot turn "Settings" here into a workspace/provider navigation action.
        if (page.kind === 'coworker') {
            if (!pageCoworker) return []
            return [...coworkerPanelSection(page.coworkerId), ...coworkerActionsSection(page.coworkerId), ...(query.trim() === ''
                ? coworkerChatSections()
                : conversationSection('coworker-conversations', 'Conversations', page.coworkerId))]
        }

        const commands = buildDesktopControlCommands({ brain: !!onBrain, sharedFiles: !!onSharedFiles, addBox: !!board && !!onAddBox, shortcuts: !!onShortcuts, notifications: !!onNotifications, workspaceSettings: !!onWorkspaceSettings, recenterBoard: !!onRecenterBoard, toggleTheme: !!onToggleTheme, darkTheme })
        const commandSections: ControlSection[] = [
            { id: 'actions', heading: 'Actions', rows: searchItems(commands.filter(command => command.group === 'actions'), text).map(commandRow) },
            { id: 'settings', heading: 'Settings', rows: searchItems(commands.filter(command => command.group === 'settings'), text).map(commandRow) },
        ]
        const searchableCoworkers = coworkers.map(coworker => ({ coworker, label: coworker.name, keywords: [coworker.description ?? '', boxName(membership(coworker.id)) ?? ''] }))

        if (scope === 'commands') return commandSections
        if (scope === 'agents') return [{ id: 'coworkers', heading: 'Coworkers', rows: searchItems(searchableCoworkers, text).map(entry => coworkerRow(entry.coworker, 'coworkers')) }]

        if (!text) {
            const waiting = coworkers.filter(coworker => {
                if (coworker.enabled === false || activity?.statuses[coworker.id] !== 'waiting_human') return false
                const target = latestBoardAttention(activity.attention, coworker.id)
                return !!target && target.agentEnabled !== false
            })
            const waitingIds = new Set(waiting.map(coworker => coworker.id))
            const recentCoworkers = recent.map(id => coworkers.find(coworker => coworker.id === id)).filter((coworker): coworker is DesktopAgentView => !!coworker && !waitingIds.has(coworker.id))
            const others = coworkers.filter(coworker => !waitingIds.has(coworker.id)).slice(0, COWORKER_RESULTS)
            const unchecked = activity && coworkers.some(coworker => coworker.enabled !== false && (!activity.statuses[coworker.id] || activity.statuses[coworker.id] === 'unknown'))
            const unavailable = activity && coworkers.some(coworker => coworker.enabled !== false && activity.statuses[coworker.id] === 'unreachable')
                || unchecked && !!activity?.attention.checkedAt
            const attentionRows = waiting.map(attentionRow)
            if (unavailable) attentionRows.push({
                id: 'needs-you-retry', label: 'Could not check all coworkers', detail: onRefreshActivity ? 'Try again' : undefined,
                leading: { kind: 'icon', icon: RefreshCwIcon }, onSelect: () => {
                    if (available()) { setAttentionNotice(null); void latest.current.onRefreshActivity?.().catch(() => {}) }
                },
            })
            const retryRows: ControlRow[] = recentState.error ? [{
                id: 'recent-retry', label: recentState.error, detail: 'Try again', leading: { kind: 'icon', icon: RefreshCwIcon },
                onSelect: () => { if (available()) recentState.retry() },
            }] : []
            return [
                { id: 'needs-you', heading: 'Needs you', rows: attentionRows, loading: !!unchecked && !activity?.attention.checkedAt },
                recentCoworkers.length > 0 ? { id: 'recent', heading: 'Recent', rows: [...recentCoworkers.map(coworker => coworkerRow(coworker, 'recent')), ...retryRows] } : { id: 'coworkers', heading: 'Coworkers', rows: others.map(coworker => coworkerRow(coworker, 'coworkers')) },
                ...(!recentCoworkers.length && retryRows.length ? [{ id: 'recent-save', heading: 'Recent', rows: retryRows }] : []),
                ...commandSections,
            ]
        }

        return [
            { id: 'coworkers', heading: 'Coworkers', rows: searchItems(searchableCoworkers, text, COWORKER_RESULTS).map(entry => coworkerRow(entry.coworker, 'coworkers')) },
            { id: 'boxes', heading: 'Boxes', rows: searchItems((board?.spaces ?? []).map(space => ({ space, label: space.name })), text, BOX_RESULTS)
                .map(({ space, label }): ControlRow => {
                    const count = coworkers.filter(coworker => membership(coworker.id) === space.id).length
                    const enter = drill({ kind: 'box', spaceId: space.id })
                    return { id: `box-${space.id}`, label, detail: count === 1 ? '1 coworker' : `${count} coworkers`, leading: { kind: 'icon', icon: BoxIcon }, onSelect: enter, onDrill: enter }
                }) },
            ...commandSections,
            ...conversationSection('conversations', 'Conversations', null),
        ]
    }

    const crumbs = page.kind === 'box' ? [pageSpace?.name ?? 'Box'] : page.kind === 'move' ? [pageCoworker?.name ?? '', 'Move to another Box'] : page.kind === 'coworker' ? [pageCoworker?.name ?? ''] : []
    const placeholder = page.kind === 'box' ? 'Search coworkers in this Box…' : page.kind === 'move' ? 'Pick a Box…' : page.kind === 'coworker' ? `Search in ${pageCoworker?.name ?? 'this coworker'}…` : 'Search coworkers, settings, conversations…'
    const emptyLabel = page.kind === 'box' && !text ? 'No coworkers in this Box yet.' : showCoworkerChats ? 'No open chats or recent conversations yet.' : page.kind === 'coworker' && text.length < MIN_CONVERSATION_QUERY
        ? 'Type at least 2 characters to search this coworker’s saved chats.'
        : 'Nothing matches.'

    return (
        <DesktopControlCenterParityView
            busy={parity.state.busy} notice={parity.state.notice}
            open={open}
            onOpenChange={setOpen}
            anchorToOrb={false}
            description="Jump to a coworker, model settings or a saved conversation."
            closeHint="to close"
            resultsHint={attentionNotice?.scope === selectionScope ? attentionNotice.text : showCoworkerChats
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
            sections={parity.merge(sections().filter(section => section.rows.length > 0 || section.loading))}
            emptyLabel={emptyLabel}
            mod={mod}
        />
    )
}
