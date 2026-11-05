'use client'

import { useEffect, useState } from 'react'
import { AGENT_TABS, type Tab } from '@/components/agent/agent-tabs'
import { desktopChatSearchSchema, type DesktopConversationHit } from './chat-search'
import { isDesktopCoworkerPanel, type DesktopCoworkerPanel } from './coworker-panel'
import { isDesktopQuitting } from './draft-writes'

type DesktopControlCoworkerTab = Tab & { id: DesktopCoworkerPanel | 'setup' }

// Reuse the original rail order and copy. Setup is a coworker authoring surface, not a
// workspace command, and only appears once the caller supplies its actual desktop handler.
export function buildDesktopControlCoworkerTabs({ panels, setup, actions }: {
    panels: boolean
    setup: boolean
    actions: boolean
}): DesktopControlCoworkerTab[] {
    return AGENT_TABS.filter((tab): tab is DesktopControlCoworkerTab => tab.id === 'setup'
        ? setup
        : panels && isDesktopCoworkerPanel(tab.id) && (tab.id !== 'actions' || actions)).map(tab => tab.id === 'triggers' ? { ...tab, description: 'URLs that start a run when called on this Mac' } : tab)
}

export const DESKTOP_CONTROL_COMMAND_IDS = ['add_coworker', 'new_box', 'shared_files', 'company_brain', 'team_board', 'model_settings', 'workspace_settings', 'recenter_board', 'toggle_theme', 'notifications', 'shortcuts'] as const

export type DesktopControlCommandId = (typeof DESKTOP_CONTROL_COMMAND_IDS)[number]

export type DesktopControlCommandGroup = 'actions' | 'settings'

// Same shape as the original control center's commands, minus everything the Mac app cannot do:
// no paid tiers, no hosted gates, and every listed action maps to a real supplied callback.
export type DesktopControlCommand = {
    id: DesktopControlCommandId
    group: DesktopControlCommandGroup
    label: string
    keywords: string[]
}

export type DesktopControlCommandOptions = {
    sharedFiles?: boolean
    brain?: boolean
    addBox?: boolean
    shortcuts?: boolean
    notifications?: boolean
    workspaceSettings?: boolean
    recenterBoard?: boolean
    toggleTheme?: boolean
    darkTheme?: boolean
}

export function buildDesktopControlCommands(options: DesktopControlCommandOptions = {}): DesktopControlCommand[] {
    const commands: DesktopControlCommand[] = [
        { id: 'add_coworker', group: 'actions', label: 'Add coworker', keywords: ['create', 'add', 'new', 'hire'] },
        { id: 'team_board', group: 'actions', label: 'Team board', keywords: ['board', 'team', 'return', 'workspace'] },
        { id: 'model_settings', group: 'settings', label: 'Model settings', keywords: ['models', 'providers', 'claude', 'chatgpt', 'openai', 'anthropic', 'api key', 'subscription'] },
    ]
    if (options.brain) commands.push({ id: 'company_brain', group: 'actions', label: 'Company Brain', keywords: ['knowledge', 'pages', 'proposals', 'company', 'team'] })
    if (options.sharedFiles) commands.push({ id: 'shared_files', group: 'actions', label: 'Shared files', keywords: ['workspace', 'documents', 'upload'] })
    if (options.addBox) commands.push({ id: 'new_box', group: 'actions', label: 'New Box', keywords: ['create', 'add', 'team', 'group'] })
    if (options.recenterBoard) commands.push({ id: 'recenter_board', group: 'actions', label: 'Recenter the board', keywords: ['camera', 'zoom', 'fit', 'reset view'] })
    if (options.toggleTheme) commands.push({ id: 'toggle_theme', group: 'actions', label: options.darkTheme ? 'Switch to light theme' : 'Switch to dark theme', keywords: ['appearance', 'mode', 'dark', 'light'] })
    if (options.workspaceSettings) commands.push({ id: 'workspace_settings', group: 'settings', label: 'Workspace settings', keywords: ['name', 'logo', 'rename'] })
    if (options.notifications) commands.push({ id: 'notifications', group: 'settings', label: 'Notifications', keywords: ['alerts', 'push', 'sound'] })
    if (options.shortcuts) commands.push({ id: 'shortcuts', group: 'settings', label: 'Keyboard shortcuts', keywords: ['keys', 'hotkeys'] })
    return commands
}

const MAX_RECENT_COWORKERS = 5

// Most recent first, each coworker once.
export function pushRecentCoworker(recent: readonly string[], coworkerId: string): string[] {
    return [coworkerId, ...recent.filter(id => id !== coworkerId)].slice(0, MAX_RECENT_COWORKERS)
}

const MIN_CONVERSATION_QUERY = 2
const DEBOUNCE_MS = 250

export type DesktopConversationSearch = {
    hits: DesktopConversationHit[]
    hasMore: boolean
    // True from the moment the query changes until its own answer lands.
    loading: boolean
    // True only when the query on screen is the one that failed.
    failed: boolean
    retry: () => void
}

// The local title-search behind the original control center's conversations, over the Mac's
// authenticated API. Stale reads are cancelled: an aborted fetch never lands, and an answer only
// counts while it is still about the query on screen, so an older result can never replace a
// newer query's own answer.
export function useDesktopConversationSearch(text: string, enabled: boolean, agentId: string | null = null): DesktopConversationSearch {
    const query = text.trim()
    const [attempt, setAttempt] = useState(0)
    const key = JSON.stringify([query, agentId, enabled, attempt])
    const [scope, setScope] = useState({ key, version: 0 })
    if (scope.key !== key) setScope({ key, version: scope.version + 1 })
    const [answer, setAnswer] = useState<{ version: number; hits: DesktopConversationHit[]; hasMore: boolean; failed?: boolean } | null>(null)

    useEffect(() => {
        if (!enabled || query.length < MIN_CONVERSATION_QUERY) return
        const controller = new AbortController()
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const params = new URLSearchParams({ q: query })
                    if (agentId) params.set('agentId', agentId)
                    const response = await fetch(`/api/desktop/conversations/search?${params}`, { signal: controller.signal, cache: 'no-store' })
                    if (!response.ok) throw new Error('Search unavailable')
                    const result = desktopChatSearchSchema.parse(await response.json())
                    if (!controller.signal.aborted) setAnswer({ version: scope.version, ...result })
                } catch {
                    if (!controller.signal.aborted) setAnswer({ version: scope.version, hits: [], hasMore: false, failed: true })
                }
            })()
        }, DEBOUNCE_MS)
        return () => { clearTimeout(timer); controller.abort() }
    }, [query, enabled, agentId, scope.version])

    const retry = () => { setAnswer(null); setAttempt(value => value + 1) }

    if (!enabled || query.length < MIN_CONVERSATION_QUERY) return { hits: [], hasMore: false, loading: false, failed: false, retry }
    if (scope.key !== key || !answer || answer.version !== scope.version) return { hits: [], hasMore: false, loading: true, failed: false, retry }
    return {
        hits: answer.hits,
        hasMore: answer.hasMore,
        loading: false,
        failed: !!answer.failed,
        retry,
    }
}

function onMac(): boolean {
    return /Mac|iPhone|iPad/i.test(navigator.userAgent)
}

// A field the user is typing in keeps its own keystrokes: the center must not take ⌘K from there.
function editingFieldFocused(): boolean {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return false
    if (active.isContentEditable) return true
    if (active instanceof HTMLTextAreaElement) return true
    if (active instanceof HTMLInputElement) {
        const type = (active.getAttribute('type') ?? 'text').toLowerCase()
        return !['checkbox', 'radio', 'button', 'submit'].includes(type)
    }
    return false
}

// ⌘F on a Mac, Ctrl+F elsewhere, exactly like the original control center: pressed while the
// center is open it closes it; otherwise it opens the center. ⌘K
// toggles the center where nothing else holds it — never from an open coworker chat or from an
// editing field. The capture listener precedes every local handler, like the original's.
export function useDesktopControlCenterKeys({ open, setOpen, conversationOpen, disabled = false }: {
    open: boolean
    setOpen: (open: boolean) => void
    conversationOpen: boolean
    disabled?: boolean
}): void {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (disabled || isDesktopQuitting() || event.defaultPrevented) return
            // Chrome autofill fires keydown events without a key.
            const key = event.key?.toLowerCase()
            if ((key !== 'f' && key !== 'k') || event.shiftKey || event.altKey) return
            const mac = onMac()
            if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return
            if (!open && document.querySelector('[role="dialog"],[role="alertdialog"]')) return
            if (key === 'k') {
                if (!open && (conversationOpen || editingFieldFocused())) return
                event.preventDefault()
                event.stopPropagation()
                setOpen(!open)
                return
            }
            if (open) {
                event.preventDefault()
                event.stopPropagation()
                setOpen(false)
                return
            }
            event.preventDefault()
            setOpen(true)
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [open, setOpen, conversationOpen, disabled])
}
