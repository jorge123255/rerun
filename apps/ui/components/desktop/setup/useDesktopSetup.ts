'use client'

import type { DesktopSetupMutationResult, DesktopSetupPost, DesktopSetupView } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createDesktopSetupClient, type DesktopSetupClient } from '@/lib/desktop/setup-client'
import type { DesktopSetupDraft } from './DesktopSetupFields'

type DesktopSetupListener = (view: DesktopSetupView) => void
const setupListeners = new Map<string, Set<DesktopSetupListener>>()

function publishDesktopSetup(agentId: string, view: DesktopSetupView) {
    for (const listener of setupListeners.get(agentId) ?? []) listener(view)
}

function subscribeDesktopSetup(agentId: string, listener: DesktopSetupListener): () => void {
    const listeners = setupListeners.get(agentId) ?? new Set<DesktopSetupListener>()
    listeners.add(listener)
    setupListeners.set(agentId, listeners)
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0) setupListeners.delete(agentId)
    }
}

export function useDesktopSetup(agentId: string) {
    const [client, setClient] = useState<DesktopSetupClient | null>(null)
    const [view, setView] = useState<DesktopSetupView | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [mutating, setMutating] = useState<DesktopSetupPost['action'] | null>(null)
    const epoch = useRef(0)
    const readEpoch = useRef(0)
    const mutationPending = useRef(false)

    useEffect(() => {
        const current = ++epoch.current
        const next = createDesktopSetupClient(agentId)
        const unsubscribe = subscribeDesktopSetup(agentId, result => {
            if (epoch.current === current) setView(result)
        })
        setClient(next)
        setView(null)
        setError('')
        setMutating(null)
        setLoading(true)
        mutationPending.current = false
        void next.read().then(result => {
            if (epoch.current === current) publishDesktopSetup(agentId, result)
        }).catch(cause => {
            if (epoch.current === current) setError(cause instanceof Error ? cause.message : 'Could not load coworker setup.')
        }).finally(() => {
            if (epoch.current === current) setLoading(false)
        })
        return () => {
            unsubscribe()
            if (epoch.current === current) epoch.current++
            readEpoch.current++
            mutationPending.current = false
            next.dispose()
        }
    }, [agentId])

    const refresh = useCallback(async () => {
        if (!client || mutationPending.current) return
        const current = epoch.current
        const request = ++readEpoch.current
        setLoading(true)
        setError('')
        try {
            const result = await client.read()
            if (epoch.current === current && readEpoch.current === request) publishDesktopSetup(agentId, result)
        } catch (cause) {
            if (epoch.current === current && readEpoch.current === request) setError(cause instanceof Error ? cause.message : 'Could not load coworker setup.')
        } finally {
            if (epoch.current === current && readEpoch.current === request) setLoading(false)
        }
    }, [agentId, client])

    const runMutation = useCallback(async (action: DesktopSetupPost['action'], draft?: DesktopSetupDraft): Promise<DesktopSetupMutationResult | null> => {
        if (!client || !view || mutationPending.current || (action === 'continue' && !view.sessionId)) {
            if (action === 'continue' && view && !view.sessionId) setError('No setup chat has been claimed yet.')
            return null
        }
        mutationPending.current = true
        const current = epoch.current
        setMutating(action)
        setError('')
        try {
            const result = action === 'save'
                ? await client.save(view, draft!)
                : action === 'start'
                    ? await client.start(view)
                    : action === 'continue'
                        ? await client.continueSetup(view)
                        : await client.skip(view)
            if (epoch.current !== current) return null
            publishDesktopSetup(agentId, result.view)
            return result
        } catch (cause) {
            if (epoch.current === current) setError(cause instanceof Error ? cause.message : 'Setup acknowledgment unavailable. Retry or reopen to read server progress.')
            return null
        } finally {
            if (epoch.current === current) {
                mutationPending.current = false
                setMutating(null)
            }
        }
    }, [agentId, client, view])

    const save = useCallback((draft: DesktopSetupDraft) => runMutation('save', draft), [runMutation])
    const start = useCallback(() => runMutation('start'), [runMutation])
    const continueSetup = useCallback(() => runMutation('continue'), [runMutation])
    const skip = useCallback(() => runMutation('skip'), [runMutation])
    const clearError = useCallback(() => setError(''), [])

    return { view, loading, error, mutating, refresh, save, start, continueSetup, skip, clearError }
}
