'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { DESKTOP_COMPLETIONS_READ_URL, DESKTOP_COMPLETIONS_URL, desktopCompletionsSchema, type DesktopCompletionItem } from '@/lib/desktop/completed-actions'

export const DESKTOP_COMPLETIONS_POLL_MS = 3000
const MAX_COMPLETIONS = 200
export type DesktopCompletionsRead = 'loading' | 'ready' | 'failed'
export type DesktopCompletionsState = {
    status: DesktopCompletionsRead
    items: DesktopCompletionItem[]
    unavailableAgentIds: string[]
    enabledAt: string | null
    checkedAt: string | null
    nextCursor: string | null
    loadingMore: boolean
    windowFull: boolean
}
export type DesktopCompletionsController = DesktopCompletionsState & {
    readError: boolean
    retry: () => void
    loadMore: () => void
    markRead: (item: DesktopCompletionItem) => void
    // `exact` (the confirmation's snapshot) makes the whole-list mark acknowledge only those IDs;
    // with no argument it keeps the click-time capture of whatever is displayed.
    markAllRead: (exact?: string[]) => void
}

const empty = (): DesktopCompletionsState => ({ status: 'loading', items: [], unavailableAgentIds: [], enabledAt: null, checkedAt: null, nextCursor: null, loadingMore: false, windowFull: false })
const keyOf = (item: DesktopCompletionItem) => JSON.stringify([item.agentId, item.id])

// Pages can split a scheduled group, or interleave it with other coworkers. Overlapping head
// polls and older pages count each opaque terminal identity once, never add server counts.
function mergeItems(previous: DesktopCompletionItem[], incoming: DesktopCompletionItem[]): DesktopCompletionItem[] {
    const groups = new Map<string, DesktopCompletionItem>()
    for (const item of [...incoming, ...previous]) {
        const prior = groups.get(keyOf(item))
        const newest = prior && prior.completedAt >= item.completedAt ? prior : item
        const completionIds = [...new Set([...(prior?.completionIds ?? []), ...item.completionIds])]
        groups.set(keyOf(item), { ...newest, completionIds, count: completionIds.length, sessionIds: [...new Set([...(prior?.sessionIds ?? []), ...item.sessionIds])] })
    }
    return [...groups.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || keyOf(a).localeCompare(keyOf(b)))
}

function canAcknowledgeVisibleConversation() {
    const chat = document.querySelector('[aria-label="Coworker chat"]')
    const modal = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')]
        .some(element => !element.closest('[hidden], [aria-hidden="true"]'))
    return document.visibilityState === 'visible' && document.hasFocus() && !isDesktopQuitting()
        && !modal && !chat?.closest('[inert], [hidden], [aria-hidden="true"]')
        && !document.body.closest('[inert]') && !document.activeElement?.closest('[inert]')
}

export function useDesktopCompletions(active = true, agentIds?: readonly string[], visibleSessionId?: string | null, observeWhileClosed = false, whileHidden = false): DesktopCompletionsController {
    const scope = agentIds ? JSON.stringify([...new Set(agentIds)].sort()) : '*'
    const lifecycle = JSON.stringify([active, scope, visibleSessionId ?? null])
    const identity = useRef({ lifecycle, generation: 0 })
    if (identity.current.lifecycle !== lifecycle) identity.current = { lifecycle, generation: identity.current.generation + 1 }
    const generation = identity.current.generation
    const enabled = active || !!visibleSessionId || observeWhileClosed
    const [state, setState] = useState<DesktopCompletionsState & { scope: string; pages: number }>({ ...empty(), scope, pages: 0 })
    const stateRef = useRef(state)
    stateRef.current = state
    const [seenVersion, setSeenVersion] = useState(0)
    const seen = useRef(new Set<string>())
    const pending = useRef(new Set<string>())
    const failed = useRef(new Set<string>())
    const inFlight = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const current = useCallback(() => mounted.current && identity.current.generation === generation, [generation])
    const allowed = useMemo(() => agentIds ? new Set(agentIds) : null, [scope])

    const read = useCallback(async (older = false, reset = false) => {
        if (!current() || !enabled || inFlight.current || (!whileHidden && document.visibilityState === 'hidden') || isDesktopQuitting()) return
        const snapshot = stateRef.current.scope === scope ? stateRef.current : { ...empty(), scope, pages: 0 }
        if (older && (!active || !snapshot.nextCursor || snapshot.windowFull)) return
        const controller = new AbortController()
        inFlight.current = controller
        if (older) setState(value => ({ ...value, loadingMore: true }))
        try {
            const url = older ? `${DESKTOP_COMPLETIONS_URL}?${new URLSearchParams({ before: snapshot.nextCursor! })}` : DESKTOP_COMPLETIONS_URL
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error(`Completions read failed (${response.status})`)
            const body = desktopCompletionsSchema.parse(await response.json())
            if (!current() || controller.signal.aborted) return
            setState(value => {
                if (!current() || controller.signal.aborted) return value
                const prior = value.scope === scope && !reset ? value : { ...empty(), scope, pages: 0 }
                const received = body.items.filter(item => !allowed || allowed.has(item.agentId))
                const items = mergeItems(prior.items, received)
                const pages = older ? 2 : Math.max(1, prior.pages)
                // Never silently discard a displayed group. Explicit refresh starts a bounded new
                // window; unread rows remain durable on the server.
                if (items.reduce((sum, item) => sum + item.completionIds.length, 0) > MAX_COMPLETIONS) {
                    return { ...prior, status: 'ready', loadingMore: false, windowFull: true }
                }
                return { scope, pages, status: 'ready', items, unavailableAgentIds: body.unavailableAgentIds.filter(id => !allowed || allowed.has(id)), enabledAt: body.enabledAt, checkedAt: body.checkedAt,
                    nextCursor: older || prior.pages <= 1 ? body.nextCursor : prior.nextCursor,
                    loadingMore: false, windowFull: prior.windowFull }
            })
        } catch (error) {
            if (!current() || controller.signal.aborted || (error as Error)?.name === 'AbortError') return
            setState(value => !current() ? value : ({ ...(value.scope === scope ? value : { ...empty(), scope, pages: 0 }), status: 'failed', loadingMore: false }))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [active, allowed, current, enabled, scope, whileHidden])

    const postSeen = useCallback(async (completionIds: string[]) => {
        if (!current() || isDesktopQuitting()) return
        const ids = [...new Set(completionIds)].filter(id => !seen.current.has(id) && !pending.current.has(id))
        if (!ids.length) return
        for (const id of ids) { seen.current.add(id); pending.current.add(id); failed.current.delete(id) }
        setSeenVersion(value => value + 1)
        try {
            const response = await fetch(DESKTOP_COMPLETIONS_READ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completionIds: ids }), cache: 'no-store' })
            if (!response.ok) throw new Error(`Mark-read failed (${response.status})`)
        } catch {
            // Keep underlying rows throughout the optimistic write: refresh/new arrivals must not
            // prevent rollback. A failure blocks auto retry for these IDs until explicit retry.
            for (const id of ids) { seen.current.delete(id); failed.current.add(id) }
        } finally {
            for (const id of ids) pending.current.delete(id)
            if (mounted.current) setSeenVersion(value => value + 1)
        }
    }, [current])

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; inFlight.current?.abort() }
    }, [])
    useEffect(() => {
        inFlight.current?.abort()
        inFlight.current = null
        setState(value => value.scope === scope ? { ...value, loadingMore: false } : { ...empty(), scope, pages: 0 })
        if (!enabled) return
        void read()
        const interval = setInterval(() => { void read() }, DESKTOP_COMPLETIONS_POLL_MS)
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                if (!whileHidden) { inFlight.current?.abort(); inFlight.current = null }
            }
            else void read()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisibility); inFlight.current?.abort(); inFlight.current = null }
    }, [enabled, generation, read, scope, whileHidden])

    const items = useMemo(() => state.scope !== scope ? [] : state.items.flatMap(item => {
        const completionIds = item.completionIds.filter(id => !seen.current.has(id))
        return completionIds.length && (!allowed || allowed.has(item.agentId)) ? [{ ...item, completionIds, count: completionIds.length }] : []
    }), [state, scope, allowed, seenVersion])
    const displayed = useRef(items)
    displayed.current = items
    const markRead = useCallback((item: DesktopCompletionItem) => {
        if (!active || !current()) return
        const live = displayed.current.find(row => row.id === item.id && row.agentId === item.agentId && row.sessionId === item.sessionId)
        if (live) void postSeen(item.completionIds.filter(id => live.completionIds.includes(id)))
    }, [active, current, postSeen])
    const markAllRead = useCallback((exact?: string[]) => {
        if (!active || !current()) return
        // With no argument this keeps the click-time capture; with `exact` (the confirmation's
        // snapshot) only those IDs leave, so a later arrival stays unread.
        const live = exact ? new Set(exact) : new Set(displayed.current.flatMap(item => item.completionIds))
        void postSeen(items.flatMap(item => item.completionIds).filter(id => live.has(id)))
    }, [active, current, items, postSeen])

    useEffect(() => {
        const acknowledge = () => {
            if (!current() || !visibleSessionId || !canAcknowledgeVisibleConversation()) return
            // Mixed-session scheduled groups cannot be individually mapped from this contract.
            // Leave them unread rather than clear completions the user has not viewed.
            const matching = displayed.current.filter(item => item.sessionId === visibleSessionId && item.sessionIds.every(id => id === visibleSessionId))
            void postSeen(matching.flatMap(item => item.completionIds).filter(id => !failed.current.has(id)))
        }
        acknowledge()
        document.addEventListener('visibilitychange', acknowledge)
        window.addEventListener('focus', acknowledge)
        const observer = new MutationObserver(acknowledge)
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['inert', 'aria-hidden', 'open', 'hidden'] })
        const unsubscribe = subscribeDraftShutdown(acknowledge)
        return () => { document.removeEventListener('visibilitychange', acknowledge); window.removeEventListener('focus', acknowledge); observer.disconnect(); unsubscribe() }
    }, [current, items, postSeen, visibleSessionId])

    const retry = useCallback(() => {
        if (!active || !current()) return
        const ids = items.flatMap(item => item.completionIds).filter(id => failed.current.has(id))
        if (ids.length) void postSeen(ids)
        void read(false, state.windowFull)
    }, [active, current, items, postSeen, read, state.windowFull])
    const loadMore = useCallback(() => { if (active && current()) void read(true) }, [active, current, read])
    return { ...(state.scope === scope ? state : empty()), items, readError: items.some(item => item.completionIds.some(id => failed.current.has(id))), retry, loadMore, markRead, markAllRead }
}
