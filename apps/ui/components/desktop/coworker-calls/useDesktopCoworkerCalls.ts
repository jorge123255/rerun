'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDesktopCoworkerCallsClient, type DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { needsDesktopCoworkerCallUpdates } from './coworker-call-progress'

export const DESKTOP_COWORKER_CALLS_POLL_MS = 3000

type ReadState = {
    scope: string
    status: 'loading' | 'ready' | 'failed'
    calls: DesktopCoworkerCallSnapshot[]
    error: string | null
}

export function useDesktopCoworkerCalls(agentId: string, sessionId: string, active = true, observing = false) {
    const scope = JSON.stringify([agentId, sessionId])
    const lifecycle = JSON.stringify([active, scope])
    const identity = useRef({ lifecycle, generation: 0 })
    if (identity.current.lifecycle !== lifecycle) identity.current = { lifecycle, generation: identity.current.generation + 1 }
    const generation = identity.current.generation
    const client = useMemo(() => createDesktopCoworkerCallsClient(agentId, sessionId), [agentId, sessionId])
    const [state, setState] = useState<ReadState>({ scope, status: 'loading', calls: [], error: null })
    const inFlight = useRef<AbortController | null>(null)
    const wasObserving = useRef(observing)
    const mounted = useRef(true)
    const current = useCallback(() => mounted.current && identity.current.generation === generation, [generation])

    const updatesNeeded = observing || state.status === 'loading' || (state.scope === scope && state.status === 'ready' && state.calls.some(needsDesktopCoworkerCallUpdates))
    const read = useCallback(async (force = false) => {
        if (!force && !updatesNeeded) return
        if (!active || !current() || isDesktopQuitting() || inFlight.current || document.visibilityState === 'hidden') return
        const controller = new AbortController()
        inFlight.current = controller
        try {
            const calls = await client.list(controller.signal)
            if (!current() || controller.signal.aborted || isDesktopQuitting()) return
            setState({ scope, status: 'ready', calls, error: null })
        } catch (cause) {
            if (!current() || controller.signal.aborted || isDesktopQuitting() || (cause as Error)?.name === 'AbortError') return
            setState(previous => ({
                ...(previous.scope === scope ? previous : { calls: [] }),
                scope, status: 'failed',
                error: cause instanceof Error ? cause.message : 'Could not load coworker calls.',
            }))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [active, client, current, scope, updatesNeeded])

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; inFlight.current?.abort() }
    }, [])
    useEffect(() => () => client.dispose(), [client])
    useEffect(() => {
        inFlight.current?.abort()
        inFlight.current = null
        setState(previous => previous.scope === scope ? previous : { scope, status: 'loading', calls: [], error: null })
        return () => { inFlight.current?.abort(); inFlight.current = null }
    }, [generation, scope])
    useEffect(() => {
        if (!active || !updatesNeeded) return
        let interval: ReturnType<typeof setInterval> | undefined
        const start = () => {
            void read()
            interval = setInterval(() => void read(), DESKTOP_COWORKER_CALLS_POLL_MS)
        }
        const stop = () => {
            clearInterval(interval)
            interval = undefined
            inFlight.current?.abort()
            inFlight.current = null
        }
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') stop()
            else if (!interval) start()
        }
        if (document.visibilityState !== 'hidden') start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [active, read, updatesNeeded])

    useEffect(() => {
        const justSettled = wasObserving.current && !observing
        wasObserving.current = observing
        if (justSettled) void read(true)
    }, [observing, read])

    const retry = useCallback(() => {
        if (active && current() && !isDesktopQuitting()) void read(true)
    }, [active, current, read])
    const replace = useCallback((call: DesktopCoworkerCallSnapshot) => {
        if (!current() || call.parentAgentId !== agentId || call.parentSessionId !== sessionId) return
        setState(previous => {
            if (previous.scope !== scope) return previous
            return { ...previous, status: 'ready', error: null, calls: previous.calls.map(candidate => candidate.callId === call.callId ? call : candidate) }
        })
    }, [agentId, sessionId, current, scope])

    const snapshot = state.scope === scope ? state : { status: 'loading' as const, calls: [], error: null }
    return { ...snapshot, client, retry, replace }
}

export type DesktopCoworkerCallsController = ReturnType<typeof useDesktopCoworkerCalls>
