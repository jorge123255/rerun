'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { DESKTOP_COMPLETIONS_READ_URL, DESKTOP_COMPLETIONS_URL, desktopCompletionsSchema, type DesktopCompletionItem } from '@/lib/desktop/completed-actions'

export const DESKTOP_COMPLETIONS_POLL_MS = 3000

export type DesktopCompletionsRead = 'loading' | 'ready' | 'failed'

export type DesktopCompletionsState = {
    status: DesktopCompletionsRead
    items: DesktopCompletionItem[]
    unavailableAgentIds: string[]
    enabledAt: string | null
    checkedAt: string | null
}

export type DesktopCompletionsController = DesktopCompletionsState & {
    retry: () => void
    /** Acknowledges exactly the completion IDs of the displayed item, then hides it locally. */
    markRead: (item: DesktopCompletionItem) => void
    /** Acknowledges every completion ID currently displayed in this panel. */
    markAllRead: () => void
}

// Polls the read-only finished-run store while the panel is open (`active`) and the window is
// visible. Marking read goes through the explicit authenticated mutation with the exact displayed
// completion IDs, so a newer arrival in the same conversation or scheduled task is never cleared.
// Root's `visibleSessionId` (the conversation on screen) applies the original
// read-on-visible-conversation semantics: rows for that conversation are acknowledged as they
// land, while the panel is active and the window is visible.
export function useDesktopCompletions(active = true, agentIds?: readonly string[], visibleSessionId?: string | null): DesktopCompletionsController {
    const scope = agentIds ? JSON.stringify([...new Set(agentIds)].sort()) : '*'
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const empty = { status: 'loading' as const, items: [], unavailableAgentIds: [], enabledAt: null, checkedAt: null }
    const [attempt, setAttempt] = useState(0)
    const [state, setState] = useState<DesktopCompletionsState & { scope: string }>({ ...empty, scope })
    const [seenVersion, setSeenVersion] = useState(0)
    const seenRef = useRef<Set<string>>(new Set())
    const inFlight = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const activeRef = useRef(active)
    activeRef.current = active

    const read = useCallback(async () => {
        if (!activeRef.current || inFlight.current || document.visibilityState === 'hidden') return
        const controller = new AbortController()
        inFlight.current = controller
        try {
            const response = await fetch(DESKTOP_COMPLETIONS_URL, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error(`Completions read failed (${response.status})`)
            const body = desktopCompletionsSchema.parse(await response.json())
            if (!mounted.current || controller.signal.aborted || scopeRef.current !== scope) return
            setState({ scope, status: 'ready', items: body.items, unavailableAgentIds: body.unavailableAgentIds, enabledAt: body.enabledAt, checkedAt: body.checkedAt })
        } catch (error) {
            if (!mounted.current || controller.signal.aborted || scopeRef.current !== scope) return
            if ((error as Error)?.name === 'AbortError') return
            setState(current => ({ ...(current.scope === scope ? current : { items: [], unavailableAgentIds: [], enabledAt: null, checkedAt: null }), scope, status: 'failed' }))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [scope])

    // A row acknowledged in this session stays hidden even if a fetch that started before the write
    // brings it back. The server keeps the authoritative seen state across restarts.
    const postSeen = useCallback(async (completionIds: string[]) => {
        const ids = [...new Set(completionIds)]
        if (ids.length === 0) return
        for (const id of ids) seenRef.current.add(id)
        setSeenVersion(value => value + 1)
        try {
            const response = await fetch(DESKTOP_COMPLETIONS_READ_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ completionIds: ids }),
                cache: 'no-store',
            })
            if (!response.ok) throw new Error(`Mark-read failed (${response.status})`)
        } catch {
            // The next read brings the rows back; the server's seen table stays authoritative.
            for (const id of ids) seenRef.current.delete(id)
            setSeenVersion(value => value + 1)
        }
    }, [])

    const markRead = useCallback((item: DesktopCompletionItem) => {
        void postSeen(item.completionIds)
    }, [postSeen])

    const markAllRead = useCallback(() => {
        // Only the rows currently displayed in this panel: a newer arrival is never swept along.
        void postSeen(displayedRef.current.flatMap(item => item.completionIds))
    }, [postSeen])

    // `read` is stable, so the interval never restarts on a re-render: one in-flight request at a
    // time, three-second polling while visible, abort on close, immediate read on reopen.
    useVisibleInterval(read, DESKTOP_COMPLETIONS_POLL_MS)

    // Closing the panel stops polling and cancels an in-flight read; opening it reads immediately.
    useEffect(() => {
        if (active) {
            setState({ status: 'loading', items: [], unavailableAgentIds: [], enabledAt: null, checkedAt: null, scope })
            void read()
        } else {
            inFlight.current?.abort()
            inFlight.current = null
        }
        return () => {
            inFlight.current?.abort()
            inFlight.current = null
        }
    }, [active, read, scope])

    // A manual retry re-reads right away, whatever the last status: it also refreshes a partial
    // read that returned confirmed items plus unavailable coworkers, not only a total failure.
    useEffect(() => {
        if (attempt > 0) void read()
    }, [attempt, read])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            inFlight.current?.abort()
        }
    }, [])

    // A completion already acknowledged this session never re-shows (the server agrees on the
    // next read). A partially acknowledged group stays until the server re-folds it.
    const items = useMemo(
        () => state.items.filter(item => !(item.completionIds.length > 0 && item.completionIds.every(id => seenRef.current.has(id)))),
        [state.items, seenVersion]
    )
    const displayedRef = useRef(items)
    displayedRef.current = items

    // Read-on-visible-conversation: a finished run whose conversation is on screen right now is
    // acknowledged as it lands, exactly like the original `view(sessionId)` marking.
    useEffect(() => {
        if (!active || !visibleSessionId || document.visibilityState === 'hidden') return
        const matching = displayedRef.current.filter(item => item.sessionId === visibleSessionId)
        if (matching.length > 0) postSeen(matching.flatMap(item => item.completionIds))
    }, [active, visibleSessionId, postSeen, items])

    const retry = useCallback(() => setAttempt(value => value + 1), [])

    return { ...(state.scope === scope ? state : empty), items, retry, markRead, markAllRead }
}
