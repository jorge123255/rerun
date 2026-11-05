'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { Button } from '@/components/ui/button'
import {
    createDesktopDelegationClient,
    visibleDelegations,
    type DesktopDelegationClient,
    type DesktopDelegationFilter,
} from '@/lib/desktop/delegation-client'
import type { DesktopDelegationSnapshot } from '../../../../../packages/contracts/src/desktop-delegation'
import { DesktopDelegationBlock } from './DesktopDelegationBlock'

export const DESKTOP_DELEGATION_POLL_MS = 3000

export type DesktopDelegationMountProps = {
    sessionId: string
    agentId?: string
    toolCallId?: string
    /** Exact parent run from D's snapshot. Leave unset for saved messages. */
    parentRunId?: string
    /** Keep reading while the parent turn is open, including before the first task appears. */
    followLive?: boolean
    output?: unknown
    errorText?: string
    dense?: boolean
    /** Shown until a snapshot for this tool call exists, so the tool row does not disappear. */
    fallback?: ReactNode
    client?: DesktopDelegationClient
}

function isLive(snapshot: DesktopDelegationSnapshot): boolean {
    return snapshot.tasks.some(task => task.status === 'queued' || task.status === 'running')
}

function Poller({ onPoll }: { onPoll: () => void }) {
    useVisibleInterval(onPoll, DESKTOP_DELEGATION_POLL_MS)
    return null
}

export function DesktopDelegationMount({ sessionId, agentId, toolCallId, parentRunId, followLive = false, output, errorText, dense = false, fallback = null, client }: DesktopDelegationMountProps) {
    const clientRef = useRef<DesktopDelegationClient | null>(client ?? null)
    const epoch = useRef(0)
    const alive = useRef(true)
    const filterRef = useRef<DesktopDelegationFilter>({ sessionId, agentId, toolCallId, parentRunId })
    filterRef.current = { sessionId, agentId, toolCallId, parentRunId }
    const filterKey = JSON.stringify(filterRef.current)
    const [rows, setRows] = useState<DesktopDelegationSnapshot[]>([])
    const [loadError, setLoadError] = useState('')

    const load = useCallback(async (signal?: AbortSignal) => {
        const seen = epoch.current
        const scope = filterRef.current
        const api = clientRef.current
        if (!api) return
        try {
            const all = await api.list(scope.sessionId, signal)
            if (!alive.current || seen !== epoch.current || signal?.aborted) return
            if (JSON.stringify(filterRef.current) !== JSON.stringify(scope)) return
            setRows(visibleDelegations(all, scope))
            setLoadError('')
        } catch (error) {
            if (!alive.current || seen !== epoch.current || signal?.aborted) return
            if (error instanceof Error && error.name === 'AbortError') return
            setLoadError(error instanceof Error && error.message ? error.message : 'Delegated tasks could not be loaded.')
        }
    }, [])

    useEffect(() => {
        const current = client ?? createDesktopDelegationClient()
        clientRef.current = current
        alive.current = true
        return () => {
            alive.current = false
            clientRef.current = null
            if (!client) current.dispose()
        }
    }, [client])

    useEffect(() => {
        epoch.current += 1
        setRows([])
        setLoadError('')
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
    }, [filterKey, load])

    const stopTask = useCallback(async (snapshot: DesktopDelegationSnapshot, taskId: string) => {
        const api = clientRef.current
        if (!api) throw new Error('Delegation unavailable or changed. Refresh and retry Stop.')
        try {
            const next = await api.stop(filterRef.current.sessionId, {
                delegationId: snapshot.delegationId,
                taskId,
                expectedRevision: snapshot.revision,
            })
            epoch.current += 1
            if (!alive.current) return
            setRows(current => current.map(item => item.delegationId === next.delegationId ? next : item))
            setLoadError('')
        } catch (error) {
            epoch.current += 1
            if (alive.current && !(error instanceof Error && error.name === 'AbortError')) void load()
            throw error
        }
    }, [load])

    const polling = followLive || rows.some(isLive)
    const poll = useCallback(() => { void load() }, [load])

    return (
        <div className="min-w-0">
            {polling && <Poller onPoll={poll} />}
            {loadError && (
                <div className="mb-1 flex items-center gap-2">
                    <p role="alert" className="min-w-0 flex-1 text-xs break-words text-red-500">{loadError}</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => { void load() }}>Retry</Button>
                </div>
            )}
            {rows.length > 0 ? rows.map(snapshot => (
                <DesktopDelegationBlock
                    key={snapshot.delegationId}
                    snapshot={snapshot}
                    agentId={agentId}
                    output={output}
                    errorText={errorText}
                    dense={dense}
                    onStopTask={taskId => stopTask(snapshot, taskId)}
                />
            )) : fallback}
        </div>
    )
}
