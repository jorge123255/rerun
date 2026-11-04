'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { DESKTOP_PENDING_INBOX_READ_URL, DESKTOP_PENDING_INBOX_URL, desktopPendingInboxReadResultSchema, desktopPendingInboxSchema,
    readTargetOf, type DesktopPendingInboxItem, type DesktopPendingReadTarget } from '@/lib/desktop/pending-inbox'

export const DESKTOP_PENDING_INBOX_POLL_MS = 3000
export type DesktopPendingInboxRead = 'loading' | 'ready' | 'failed'
export type DesktopPendingInboxState = {
    status: DesktopPendingInboxRead
    items: DesktopPendingInboxItem[]
    unavailableAgentIds: string[]
    checkedAt: string | null
}
export type DesktopPendingInboxController = DesktopPendingInboxState & {
    /** True while at least one displayed item failed to mark read; Retry re-posts exactly those. */
    readError: boolean
    retry: () => void
    markRead: (item: DesktopPendingInboxItem) => void
    markAllRead: (items: DesktopPendingInboxItem[]) => void
}

// Polls the pending inbox (shared attention minus the inbox's own durable read receipts) while the
// panel is open (`active`) and the window is visible. Marking read is explicit only: opening a row
// never acknowledges anything, and a failed or stale mark stays visible with a retry.
export function useDesktopPendingInbox(active = true, agentIds?: readonly string[]): DesktopPendingInboxController {
    const scope = agentIds ? JSON.stringify([...new Set(agentIds)].sort()) : '*'
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const empty = { status: 'loading' as const, items: [], unavailableAgentIds: [], checkedAt: null }
    const [attempt, setAttempt] = useState(0)
    const [state, setState] = useState<DesktopPendingInboxState & { scope: string }>({ ...empty, scope })
    const inFlight = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const activeRef = useRef(active)
    activeRef.current = active
    // Confirmed-read item ids: hidden locally the moment the server confirms, then re-confirmed by
    // the next poll. A failed mark is kept keyed to its target so Retry re-posts exactly those.
    const hidden = useRef(new Set<string>())
    const pendingWrites = useRef(new Set<string>())
    const failed = useRef(new Map<string, DesktopPendingReadTarget>())
    const [version, setVersion] = useState(0)

    const read = useCallback(async () => {
        if (!activeRef.current || inFlight.current || document.visibilityState === 'hidden') return
        const controller = new AbortController()
        inFlight.current = controller
        try {
            const response = await fetch(DESKTOP_PENDING_INBOX_URL, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error(`Pending inbox read failed (${response.status})`)
            const body = desktopPendingInboxSchema.parse(await response.json())
            if (!mounted.current || controller.signal.aborted || scopeRef.current !== scope) return
            setState({ scope, status: 'ready', items: body.items, unavailableAgentIds: body.unavailableAgentIds, checkedAt: body.checkedAt })
        } catch (error) {
            if (!mounted.current || controller.signal.aborted || scopeRef.current !== scope) return
            if ((error as Error)?.name === 'AbortError') return
            setState(currentState => ({ ...(currentState.scope === scope ? currentState : { items: [], unavailableAgentIds: [], checkedAt: null }), scope, status: 'failed' }))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [scope])

    const postRead = useCallback(async (targets: DesktopPendingReadTarget[]) => {
        if (!mounted.current || scopeRef.current !== scope) return
        const chosen = new Map<string, DesktopPendingReadTarget>()
        for (const target of targets) {
            if (chosen.has(target.id) || hidden.current.has(target.id) || pendingWrites.current.has(target.id)) continue
            chosen.set(target.id, target)
        }
        if (!chosen.size) return
        const sent = [...chosen.values()]
        for (const target of sent) { pendingWrites.current.add(target.id); failed.current.delete(target.id) }
        try {
            const response = await fetch(DESKTOP_PENDING_INBOX_READ_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: sent }), cache: 'no-store',
            })
            if (!response.ok) throw new Error(`Mark-read failed (${response.status})`)
            const result = desktopPendingInboxReadResultSchema.parse(await response.json())
            const rejected = new Set(result.failedIds)
            for (const target of sent) {
                if (rejected.has(target.id)) failed.current.set(target.id, target)
                else { hidden.current.add(target.id); failed.current.delete(target.id) }
            }
        } catch {
            // Keep the rows throughout the failed write: nothing is hidden, retry re-posts them.
            for (const target of sent) failed.current.set(target.id, target)
        } finally {
            for (const target of sent) pendingWrites.current.delete(target.id)
            if (mounted.current) setVersion(value => value + 1)
        }
    }, [scope])

    useVisibleInterval(read, DESKTOP_PENDING_INBOX_POLL_MS)

    // Opening the panel stops polling and cancels an in-flight read; opening it reads immediately.
    useEffect(() => {
        if (active) {
            setState({ status: 'loading', items: [], unavailableAgentIds: [], checkedAt: null, scope })
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

    // A manual retry re-reads right away, whatever the last status.
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

    const items = useMemo(() => (state.scope !== scope ? [] : state.items.filter(item => !hidden.current.has(item.id))), [state, scope, version])
    const displayed = useRef(items)
    displayed.current = items
    const readError = items.some(item => failed.current.has(item.id))

    const markRead = useCallback((item: DesktopPendingInboxItem) => {
        if (!activeRef.current || !mounted.current || scopeRef.current !== scope) return
        const live = displayed.current.find(row => row.id === item.id && row.agentId === item.agentId && row.sessionId === item.sessionId)
        if (!live) return
        void postRead([readTargetOf(live)])
    }, [postRead, scope])

    const markAllRead = useCallback((items: DesktopPendingInboxItem[]) => {
        if (!activeRef.current || !mounted.current || scopeRef.current !== scope) return
        // Capture exactly the rows the confirmation opened with: a later arrival stays unread.
        const live = new Set(displayed.current.map(row => row.id))
        void postRead(items.filter(item => live.has(item.id)).map(readTargetOf))
    }, [postRead, scope])

    const retry = useCallback(() => {
        if (!activeRef.current || !mounted.current || scopeRef.current !== scope) return
        if (failed.current.size) void postRead([...failed.current.values()])
        setAttempt(value => value + 1)
    }, [postRead, scope])

    return { ...(state.scope === scope ? state : empty), items, readError, retry, markRead, markAllRead }
}
