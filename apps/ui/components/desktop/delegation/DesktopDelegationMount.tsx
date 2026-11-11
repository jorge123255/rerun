'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { Button } from '@/components/ui/button'
import {
    DELEGATION_LIST_UNAVAILABLE,
    DELEGATION_LIST_UNREADABLE,
    DELEGATION_STOP_UNAVAILABLE,
    DELEGATION_UNREADABLE,
    DesktopDelegationReadError,
    createDesktopDelegationClient,
    projectDelegations,
    visibleDelegations,
    type DesktopDelegationClient,
    type DesktopDelegationFilter,
    type DesktopDelegationScope,
} from '@/lib/desktop/delegation-client'
import type { DesktopDelegationSnapshot } from '@rerun/contracts'
import { DesktopDelegationBlock } from './DesktopDelegationBlock'

export const DESKTOP_DELEGATION_POLL_MS = 3000

export type DesktopDelegationView = 'live' | 'history'

export type DesktopDelegationMountProps = {
    sessionId: string
    scope?: DesktopDelegationScope
    /** Restrict Stop to this parent run. Null makes the saved tasks read-only. */
    stopRunId?: string | null
    agentId?: string
    toolCallId?: string
    /** Exact parent run from D's snapshot. Leave unset for saved messages. */
    parentRunId?: string
    /**
     * `live` polls while this turn is open or a visible task is queued or running.
     * `history` reads once and does not poll or start a header clock.
     */
    view?: DesktopDelegationView
    /** Keep reading while the parent turn is open, including before the first task appears. */
    followLive?: boolean
    output?: unknown
    errorText?: string
    dense?: boolean
    /** Shown while loading, when the filtered list is empty, or when the read cannot be shown. */
    fallback?: ReactNode
    placeCard?: (snapshot: DesktopDelegationSnapshot, card: ReactNode) => ReactNode
    client?: DesktopDelegationClient
    /** GET-shaped transcript `{delegations}`. A shape failure is malformed, not an empty success. */
    projection?: unknown
    /** Root-supplied snapshots for a parent Stop or live outcome. Applied without posting Stop. */
    parentSnapshots?: readonly DesktopDelegationSnapshot[]
}

type ReadPhase = 'loading' | 'empty' | 'unavailable' | 'malformed' | 'ready'
type ReadBanner = { kind: 'unavailable' | 'malformed'; message: string }

function isLive(snapshot: DesktopDelegationSnapshot): boolean {
    return snapshot.tasks.some(task => task.status === 'queued' || task.status === 'running')
}

function supplyKey(projection: unknown, snapshots: readonly DesktopDelegationSnapshot[] | undefined): string {
    if (projection === undefined && snapshots === undefined) return ''
    try {
        return JSON.stringify(projection === undefined ? { snapshots } : { projection })
    } catch {
        return 'unreadable'
    }
}

function failureOf(error: unknown): ReadBanner {
    if (error instanceof DesktopDelegationReadError && error.kind === 'malformed') {
        return { kind: 'malformed', message: error.message || DELEGATION_LIST_UNREADABLE }
    }
    if (error instanceof Error && (error.message === DELEGATION_LIST_UNREADABLE || error.message === DELEGATION_UNREADABLE)) {
        return { kind: 'malformed', message: error.message }
    }
    const message = error instanceof Error && error.message ? error.message : DELEGATION_LIST_UNAVAILABLE
    return { kind: 'unavailable', message }
}

function sameTarget(next: DesktopDelegationSnapshot, scope: DesktopDelegationFilter, delegationId: string, taskId: string): boolean {
    if (next.delegationId !== delegationId || next.parentSessionId !== scope.sessionId) return false
    if (scope.agentId !== undefined && next.parentAgentId !== scope.agentId) return false
    if (scope.toolCallId !== undefined && next.toolCallId !== scope.toolCallId) return false
    if (scope.parentRunId !== undefined && next.parentRunId !== scope.parentRunId) return false
    return next.tasks.some(task => task.taskId === taskId)
}

function Poller({ onPoll }: { onPoll: () => void }) {
    useVisibleInterval(onPoll, DESKTOP_DELEGATION_POLL_MS)
    return null
}

export function DesktopDelegationMount({
    sessionId,
    scope = 'coworker',
    stopRunId,
    agentId,
    toolCallId,
    parentRunId,
    view = 'live',
    followLive = false,
    output,
    errorText,
    dense = false,
    fallback = null,
    placeCard,
    client,
    projection,
    parentSnapshots,
}: DesktopDelegationMountProps) {
    const clientRef = useRef<DesktopDelegationClient | null>(client ?? null)
    const epoch = useRef(0)
    const writes = useRef(0)
    const supplied = useRef(false)
    const alive = useRef(true)
    const readAbort = useRef<AbortController | null>(null)
    const previousStopRun = useRef(stopRunId)
    const rowCount = useRef(0)
    const rowsRef = useRef<DesktopDelegationSnapshot[]>([])
    const filterRef = useRef<DesktopDelegationFilter>({ sessionId, agentId, toolCallId, parentRunId })
    filterRef.current = { sessionId, agentId, toolCallId, parentRunId }
    const viewRef = useRef(view)
    viewRef.current = view
    const projectionRef = useRef(projection)
    const parentRef = useRef(parentSnapshots)
    projectionRef.current = projection
    parentRef.current = parentSnapshots
    const filterKey = JSON.stringify(filterRef.current)
    const suppliedKey = supplyKey(projection, parentSnapshots)
    const [rows, setRows] = useState<DesktopDelegationSnapshot[]>([])
    const [phase, setPhase] = useState<ReadPhase>('loading')
    const [banner, setBanner] = useState<ReadBanner | null>(null)

    const replaceRows = useCallback((next: DesktopDelegationSnapshot[]) => {
        rowCount.current = next.length
        rowsRef.current = next
        setRows(next)
    }, [])

    const load = useCallback(async (signal?: AbortSignal, seen = epoch.current) => {
        const scope = filterRef.current
        const seenWrites = writes.current
        const api = clientRef.current
        if (!api) return
        try {
            const all = await api.list(scope.sessionId, signal)
            if (!alive.current || seen !== epoch.current || seenWrites !== writes.current || signal?.aborted) return
            if (JSON.stringify(filterRef.current) !== JSON.stringify(scope)) return
            if (viewRef.current === 'history' && supplied.current) return
            const visible = visibleDelegations(all, scope)
            replaceRows(visible)
            setBanner(null)
            setPhase(visible.length ? 'ready' : 'empty')
        } catch (error) {
            if (!alive.current || seen !== epoch.current || signal?.aborted) return
            if (error instanceof Error && error.name === 'AbortError') return
            if (viewRef.current === 'history' && supplied.current) return
            const failure = failureOf(error)
            setBanner(failure)
            setPhase(rowCount.current ? 'ready' : failure.kind)
        }
    }, [replaceRows])

    const retry = useCallback(() => {
        readAbort.current?.abort()
        const controller = new AbortController()
        readAbort.current = controller
        void load(controller.signal, epoch.current)
    }, [load])

    useEffect(() => {
        const current = client ?? createDesktopDelegationClient(undefined, scope)
        clientRef.current = current
        alive.current = true
        return () => {
            alive.current = false
            readAbort.current?.abort()
            clientRef.current = null
            if (!client) current.dispose()
        }
    }, [client, scope])

    useEffect(() => {
        const generation = ++epoch.current
        supplied.current = false
        replaceRows([])
        setBanner(null)
        setPhase('loading')
        const controller = new AbortController()
        readAbort.current = controller
        void load(controller.signal, generation)
        return () => controller.abort()
    }, [filterKey, load, replaceRows, client, scope])

    useEffect(() => {
        const previous = previousStopRun.current
        previousStopRun.current = stopRunId
        if (previous && previous !== stopRunId) retry()
    }, [stopRunId, retry])

    useEffect(() => {
        if (suppliedKey === '') return
        const generation = ++epoch.current
        const scope = filterRef.current
        try {
            const next = projectionRef.current !== undefined
                ? projectDelegations(projectionRef.current, scope)
                : visibleDelegations(parentRef.current ?? [], scope)
            if (generation !== epoch.current) return
            supplied.current = true
            writes.current += 1
            replaceRows(next)
            setBanner(null)
            setPhase(next.length ? 'ready' : 'empty')
        } catch (error) {
            if (generation !== epoch.current) return
            supplied.current = false
            const failure = failureOf(error)
            setBanner({ kind: 'malformed', message: failure.message || DELEGATION_LIST_UNREADABLE })
            setPhase(rowCount.current ? 'ready' : 'malformed')
        }
    }, [suppliedKey, filterKey, replaceRows, client])

    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                readAbort.current?.abort()
                return
            }
            if (viewRef.current === 'history' && (rowCount.current > 0 || supplied.current)) return
            const controller = new AbortController()
            readAbort.current = controller
            void load(controller.signal, epoch.current)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
    }, [load])

    const stopTask = useCallback(async (snapshot: DesktopDelegationSnapshot, taskId: string) => {
        const api = clientRef.current
        if (!api) throw new Error(DELEGATION_STOP_UNAVAILABLE)
        const task = snapshot.tasks.find(task => task.taskId === taskId)
        if (!task) throw new Error(DELEGATION_STOP_UNAVAILABLE)
        const generation = ++epoch.current
        const scope = filterRef.current
        const scopeKey = JSON.stringify(scope)
        try {
            const next = await api.stop(scope.sessionId, {
                delegationId: snapshot.delegationId,
                taskId,
                expectedRevision: task.stopRevision ?? snapshot.revision,
            })
            if (!alive.current || generation !== epoch.current) return
            if (JSON.stringify(filterRef.current) !== scopeKey) return
            if (!sameTarget(next, scope, snapshot.delegationId, taskId)) throw new Error(DELEGATION_STOP_UNAVAILABLE)
            writes.current += 1
            replaceRows(rowsRef.current.map(item => item.delegationId === next.delegationId ? next : item))
            setBanner(null)
            setPhase('ready')
        } catch (error) {
            if (!alive.current || (error instanceof Error && error.name === 'AbortError')) return
            if (generation !== epoch.current) return
            epoch.current += 1
            await load(undefined, epoch.current)
            throw error
        }
    }, [load, replaceRows])

    const polling = view === 'live' && (followLive || rows.some(isLive))
    const poll = useCallback(() => {
        readAbort.current?.abort()
        const controller = new AbortController()
        readAbort.current = controller
        void load(controller.signal, epoch.current)
    }, [load])

    return (
        <div className="min-w-0 empty:hidden" data-state={phase} data-view={view}>
            {polling && <Poller onPoll={poll} />}
            {banner && (
                <div className="mb-1 flex items-center gap-2" data-read={banner.kind}>
                    <p role="alert" className="min-w-0 flex-1 text-xs break-words text-red-500">{banner.message}</p>
                    <Button type="button" size="sm" variant="outline" onClick={retry}>Retry</Button>
                </div>
            )}
            {rows.length > 0 ? rows.map(snapshot => {
                const card = <DesktopDelegationBlock
                    key={snapshot.delegationId}
                    snapshot={snapshot}
                    agentId={agentId}
                    output={output}
                    errorText={errorText}
                    dense={dense}
                    showLiveClock={view === 'live' && isLive(snapshot)}
                    onStopTask={stopRunId === undefined || stopRunId === snapshot.parentRunId ? taskId => stopTask(snapshot, taskId) : undefined}
                />
                return placeCard ? placeCard(snapshot, card) : card
            }) : fallback}
        </div>
    )
}
