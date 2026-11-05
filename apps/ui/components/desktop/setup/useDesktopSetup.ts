'use client'

import type { DesktopSetupMutationResult, DesktopSetupPost, DesktopSetupView } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createDesktopSetupClient, type DesktopSetupClient } from '@/lib/desktop/setup-client'
import type { DesktopSetupDraft } from './DesktopSetupFields'

type Action = DesktopSetupPost['action']
type SetupEvent = { kind: 'view'; view: DesktopSetupView; source: 'read' | 'mutation' } | { kind: 'busy'; action: Action | null }
type SetupOwner = {
    generation: number
    readSequence: number
    mutation: { token: symbol; action: Action } | null
    view: DesktopSetupView | null
    listeners: Set<(event: SetupEvent) => void>
}
const owners = new Map<string, SetupOwner>()

function ownerOf(agentId: string): SetupOwner {
    let owner = owners.get(agentId)
    if (!owner) {
        owner = { generation: 0, readSequence: 0, mutation: null, view: null, listeners: new Set() }
        owners.set(agentId, owner)
    }
    return owner
}
function retireOwner(agentId: string, owner: SetupOwner) {
    if (owners.get(agentId) === owner && owner.listeners.size === 0 && owner.mutation === null) owners.delete(agentId)
}
function publishView(agentId: string, owner: SetupOwner, view: DesktopSetupView, source: 'read' | 'mutation') {
    if (owners.get(agentId) !== owner || view.agentId !== agentId) return
    owner.view = view
    for (const listener of owner.listeners) listener({ kind: 'view', view, source })
}
function publishBusy(owner: SetupOwner) {
    for (const listener of owner.listeners) listener({ kind: 'busy', action: owner.mutation?.action ?? null })
}
type ReadToken = { generation: number; sequence: number }
function beginRead(owner: SetupOwner): ReadToken | null {
    if (owner.mutation) return null
    return { generation: owner.generation, sequence: ++owner.readSequence }
}
function currentRead(agentId: string, owner: SetupOwner, token: ReadToken): boolean {
    return owners.get(agentId) === owner && owner.mutation === null && owner.generation === token.generation && owner.readSequence === token.sequence
}

export function useDesktopSetup(agentId: string) {
    const [client, setClient] = useState<DesktopSetupClient | null>(null)
    const [view, setView] = useState<DesktopSetupView | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [mutating, setMutating] = useState<Action | null>(null)
    const epoch = useRef(0)
    const readEpoch = useRef(0)
    const mutationPending = useRef(false)
    const shared = useRef<SetupOwner | null>(null)
    const failure = useRef<{ kind: 'read' | 'mutation' | 'local'; revision?: string } | null>(null)

    const clearError = useCallback(() => { failure.current = null; setError('') }, [])

    useEffect(() => {
        const current = ++epoch.current
        const next = createDesktopSetupClient(agentId)
        const owner = ownerOf(agentId)
        shared.current = owner
        const listener = (event: SetupEvent) => {
            if (epoch.current !== current) return
            if (event.kind === 'busy') {
                setMutating(event.action)
                return
            }
            setView(event.view)
            setLoading(false)
            // A valid read repairs another panel's failed read. Keep a local failed mutation's
            // message if a read only repeats its old revision and cannot acknowledge that save.
            if (failure.current?.kind === 'read' || event.source === 'mutation' || failure.current?.revision !== event.view.revision) clearError()
        }
        owner.listeners.add(listener)
        setClient(next)
        setView(owner.view)
        clearError()
        setMutating(owner.mutation?.action ?? null)
        mutationPending.current = false
        const request = ++readEpoch.current
        const token = beginRead(owner)
        setLoading(token !== null)
        if (token) void next.read().then(result => {
            if (epoch.current === current && readEpoch.current === request && currentRead(agentId, owner, token)) publishView(agentId, owner, result, 'read')
        }).catch(cause => {
            if (epoch.current === current && readEpoch.current === request && currentRead(agentId, owner, token)) {
                failure.current = { kind: 'read' }
                setError(cause instanceof Error ? cause.message : 'Could not load coworker setup.')
            }
        }).finally(() => {
            if (epoch.current === current && readEpoch.current === request) setLoading(false)
        })
        return () => {
            owner.listeners.delete(listener)
            retireOwner(agentId, owner)
            if (epoch.current === current) epoch.current++
            readEpoch.current++
            mutationPending.current = false
            shared.current = null
            next.dispose()
        }
    }, [agentId, clearError])

    const refresh = useCallback(async () => {
        const owner = shared.current
        if (!client || !owner || mutationPending.current) return
        const token = beginRead(owner)
        if (!token) return
        const current = epoch.current
        const request = ++readEpoch.current
        setLoading(true)
        // Do not erase an unknown save merely because a separate panel asks for a refresh.
        if (failure.current?.kind === 'read') clearError()
        try {
            const result = await client.read()
            if (epoch.current === current && readEpoch.current === request && currentRead(agentId, owner, token)) publishView(agentId, owner, result, 'read')
        } catch (cause) {
            if (epoch.current === current && readEpoch.current === request && currentRead(agentId, owner, token)) {
                failure.current = { kind: 'read' }
                setError(cause instanceof Error ? cause.message : 'Could not load coworker setup.')
            }
        } finally {
            if (epoch.current === current && readEpoch.current === request) setLoading(false)
        }
    }, [agentId, client, clearError])

    const runMutation = useCallback(async (action: Action, draft?: DesktopSetupDraft): Promise<DesktopSetupMutationResult | null> => {
        const owner = shared.current
        if (!client || !view || !owner || owner.mutation || mutationPending.current || (action === 'continue' && !view.sessionId)) {
            if (action === 'continue' && view && !view.sessionId && !owner?.mutation) {
                failure.current = { kind: 'local', revision: view.revision }
                setError('No setup chat has been claimed yet.')
            }
            return null
        }
        mutationPending.current = true
        const current = epoch.current
        const token = Symbol('setup-mutation')
        // Revisions are opaque hashes, so ordering comes from a shared owner generation. Every
        // earlier read, including another hook's initial read, is invalid before submission.
        owner.generation++
        owner.mutation = { token, action }
        publishBusy(owner)
        clearError()
        try {
            const result = action === 'save'
                ? await client.save(view, draft!)
                : action === 'start'
                    ? await client.start(view)
                    : action === 'continue'
                        ? await client.continueSetup(view)
                        : await client.skip(view)
            if (epoch.current !== current || owners.get(agentId) !== owner || owner.mutation?.token !== token) return null
            publishView(agentId, owner, result.view, 'mutation')
            return result
        } catch (cause) {
            if (epoch.current === current) {
                failure.current = { kind: 'mutation', revision: view.revision }
                setError(cause instanceof Error ? cause.message : 'Setup acknowledgment unavailable. Retry or reopen to read server progress.')
            }
            return null
        } finally {
            if (owner.mutation?.token === token) {
                owner.mutation = null
                owner.generation++
                publishBusy(owner)
                retireOwner(agentId, owner)
            }
            if (epoch.current === current) mutationPending.current = false
        }
    }, [agentId, client, view, clearError])

    const save = useCallback((draft: DesktopSetupDraft) => runMutation('save', draft), [runMutation])
    const start = useCallback(() => runMutation('start'), [runMutation])
    const continueSetup = useCallback(() => runMutation('continue'), [runMutation])
    const skip = useCallback(() => runMutation('skip'), [runMutation])

    return { view, loading, error, mutating, refresh, save, start, continueSetup, skip, clearError }
}
