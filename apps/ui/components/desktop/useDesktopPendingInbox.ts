'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
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
// window is visible; the board can observe counts while the panel is closed. Mutations still
// require an active panel and its current lifecycle. Opening a row
// never acknowledges anything, and a failed or stale mark stays visible with a retry.
export function useDesktopPendingInbox(active = true, agentIds?: readonly string[], observeWhileClosed = false): DesktopPendingInboxController {
    const scope = agentIds ? JSON.stringify([...new Set(agentIds)].sort()) : '*'
    const lifecycle = JSON.stringify([active, scope])
    const identity = useRef({ lifecycle, generation: 0 })
    if (identity.current.lifecycle !== lifecycle) identity.current = { lifecycle, generation: identity.current.generation + 1 }
    const generation = identity.current.generation
    const enabled = active || observeWhileClosed
    const allowed = useMemo(() => agentIds ? new Set(agentIds) : null, [scope])
    const empty = { status: 'loading' as const, items: [], unavailableAgentIds: [], checkedAt: null }
    const [attempt, setAttempt] = useState(0)
    const [state, setState] = useState<DesktopPendingInboxState & { scope: string }>({ ...empty, scope })
    const inFlight = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const current = useCallback(() => mounted.current && identity.current.generation === generation, [generation])
    // Confirmed-read item ids: hidden locally the moment the server confirms, then re-confirmed by
    // the next poll. A failed mark is kept keyed to its target so Retry re-posts exactly those.
    const hidden = useRef(new Set<string>())
    const pendingWrites = useRef(new Set<string>())
    const failed = useRef(new Map<string, DesktopPendingReadTarget>())
    const [version, setVersion] = useState(0)

    const read = useCallback(async () => {
        if (!current() || !enabled || isDesktopQuitting() || inFlight.current || document.visibilityState === 'hidden') return
        const controller = new AbortController()
        inFlight.current = controller
        try {
            const response = await fetch(DESKTOP_PENDING_INBOX_URL, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error(`Pending inbox read failed (${response.status})`)
            const body = desktopPendingInboxSchema.parse(await response.json())
            if (!current() || controller.signal.aborted || isDesktopQuitting()) return
            setState({ scope, status: 'ready', items: body.items, unavailableAgentIds: body.unavailableAgentIds, checkedAt: body.checkedAt })
        } catch (error) {
            if (!current() || controller.signal.aborted || isDesktopQuitting()) return
            if ((error as Error)?.name === 'AbortError') return
            setState(currentState => ({ ...(currentState.scope === scope ? currentState : { items: [], unavailableAgentIds: [], checkedAt: null }), scope, status: 'failed' }))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [current, enabled, scope])

    const postRead = useCallback(async (targets: DesktopPendingReadTarget[]) => {
        if (!active || !current() || isDesktopQuitting()) return
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
    }, [active, current])

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; inFlight.current?.abort() }
    }, [])
    // Roster/open-cycle changes invalidate retained callbacks and old reads. Preserve a current
    // snapshot while refreshing, so opening the inbox does not erase its already-live count.
    useEffect(() => {
        inFlight.current?.abort()
        inFlight.current = null
        setState(value => value.scope === scope ? value : { ...empty, scope })
        return () => { inFlight.current?.abort(); inFlight.current = null }
    }, [generation, scope])
    useVisibleInterval(read, DESKTOP_PENDING_INBOX_POLL_MS)
    useEffect(() => {
        const stopHiddenRead = () => {
            if (document.visibilityState === 'hidden') { inFlight.current?.abort(); inFlight.current = null }
        }
        document.addEventListener('visibilitychange', stopHiddenRead)
        return () => document.removeEventListener('visibilitychange', stopHiddenRead)
    }, [])
    useEffect(() => { if (attempt > 0) void read() }, [attempt, read])

    const items = useMemo(() => (state.scope !== scope ? [] : state.items.filter(item => (!allowed || allowed.has(item.agentId)) && !hidden.current.has(item.id))), [state, scope, allowed, version])
    const displayed = useRef(items)
    displayed.current = items
    const readError = items.some(item => failed.current.has(item.id))

    const markRead = useCallback((item: DesktopPendingInboxItem) => {
        if (!active || !current() || isDesktopQuitting()) return
        const live = displayed.current.find(row => row.id === item.id && row.agentId === item.agentId && row.sessionId === item.sessionId && row.kind === item.kind)
        if (!live) return
        void postRead([readTargetOf(live)])
    }, [active, current, postRead])

    const markAllRead = useCallback((items: DesktopPendingInboxItem[]) => {
        if (!active || !current() || isDesktopQuitting()) return
        // Capture exactly the rows the confirmation opened with: a later arrival stays unread.
        const matches = (item: DesktopPendingInboxItem) => displayed.current.some(row => row.id === item.id && row.kind === item.kind && row.agentId === item.agentId && row.sessionId === item.sessionId)
        void postRead(items.filter(matches).map(readTargetOf))
    }, [active, current, postRead])

    const retry = useCallback(() => {
        if (!active || !current() || isDesktopQuitting()) return
        const targets = displayed.current.filter(item => {
            const target = failed.current.get(item.id)
            return target && target.kind === item.kind && target.agentId === item.agentId && target.sessionId === item.sessionId
        }).map(readTargetOf)
        if (targets.length) void postRead(targets)
        setAttempt(value => value + 1)
    }, [active, current, postRead])

    const snapshot = state.scope === scope ? state : empty
    return { ...snapshot, unavailableAgentIds: snapshot.unavailableAgentIds.filter(id => !allowed || allowed.has(id)), items, readError, retry, markRead, markAllRead }
}
