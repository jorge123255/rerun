'use client'

import { useEffect, useState } from 'react'
import { desktopChatSearchSchema, type DesktopConversationHit } from './chat-search'

export const DESKTOP_CONTROL_COMMAND_IDS = ['add_coworker', 'team_board', 'model_settings'] as const

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

export function buildDesktopControlCommands(): DesktopControlCommand[] {
    return [
        { id: 'add_coworker', group: 'actions', label: 'Add coworker', keywords: ['create', 'add', 'new', 'hire'] },
        { id: 'team_board', group: 'actions', label: 'Team board', keywords: ['board', 'team', 'return', 'workspace'] },
        { id: 'model_settings', group: 'settings', label: 'Model settings', keywords: ['models', 'providers', 'claude', 'chatgpt', 'openai', 'anthropic', 'api key', 'subscription'] },
    ]
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
export function useDesktopConversationSearch(text: string, enabled: boolean): DesktopConversationSearch {
    const query = text.trim()
    const [attempt, setAttempt] = useState(0)
    const [answer, setAnswer] = useState<{ text: string; hits: DesktopConversationHit[]; hasMore: boolean; failed?: boolean } | null>(null)

    useEffect(() => {
        if (!enabled || query.length < MIN_CONVERSATION_QUERY) return
        const controller = new AbortController()
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const response = await fetch(`/api/desktop/conversations/search?q=${encodeURIComponent(query)}`, { signal: controller.signal, cache: 'no-store' })
                    if (!response.ok) throw new Error('Search unavailable')
                    const result = desktopChatSearchSchema.parse(await response.json())
                    if (!controller.signal.aborted) setAnswer({ text: query, ...result })
                } catch {
                    if (!controller.signal.aborted) setAnswer({ text: query, hits: [], hasMore: false, failed: true })
                }
            })()
        }, DEBOUNCE_MS)
        return () => { clearTimeout(timer); controller.abort() }
    }, [query, enabled, attempt])

    const retry = () => { setAnswer(null); setAttempt(value => value + 1) }

    if (!enabled || query.length < MIN_CONVERSATION_QUERY) return { hits: [], hasMore: false, loading: false, failed: false, retry }
    if (!answer || answer.text !== query) return { hits: [], hasMore: false, loading: true, failed: false, retry }
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
// center is open it only closes it and claims nothing else; otherwise it opens the center. ⌘K
// toggles the center where nothing else holds it — never from an open coworker chat or from an
// editing field. The capture listener precedes every local handler, like the original's.
export function useDesktopControlCenterKeys({ open, setOpen, conversationOpen }: {
    open: boolean
    setOpen: (open: boolean) => void
    conversationOpen: boolean
}): void {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            // Chrome autofill fires keydown events without a key.
            const key = event.key?.toLowerCase()
            if ((key !== 'f' && key !== 'k') || event.shiftKey || event.altKey) return
            const mac = onMac()
            if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return
            if (key === 'k') {
                if (!open && (conversationOpen || editingFieldFocused())) return
                event.preventDefault()
                event.stopPropagation()
                setOpen(!open)
                return
            }
            if (open) {
                setOpen(false)
                return
            }
            event.preventDefault()
            setOpen(true)
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [open, setOpen, conversationOpen])
}
