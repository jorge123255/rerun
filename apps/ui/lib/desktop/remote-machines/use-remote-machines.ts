'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DESKTOP_REMOTE_MACHINE_LIMITS, type DesktopRemoteActor, type DesktopRemoteSnapshot } from '@rerun/contracts'
import {
    createDesktopRemoteMachinesClient,
    RemoteMachineRequestError,
    type RemoteMachineActorSeed,
    type RemoteMachineRefusalCode,
} from './remote-machines-client'

/**
 * Panel-wide state for a workspace's remote machine. Polls the service with
 * observational reads (never a connect as an effect of viewing or restoring
 * the dialog), quick while a change is in flight. Mutations are serialized,
 * every command carries the panel's actor, and a response that does not carry
 * this panel's renderer epoch is dropped — a stale answer cannot relabel a
 * newer machine. A lost acknowledgement keeps its request identity and the
 * typed form input so a retry converges instead of duplicating.
 */
const POLL_RELAXED_MS = 3000
const POLL_QUICK_MS = 1200

export type RemoteMachineBusyKind = 'pair' | 'replace' | 'remove' | 'select' | 'health' | 'cancel' | 'recover' | 'retry'
export type RemoteMachineBusy = { kind: RemoteMachineBusyKind; requestId: string }

function newId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useRemoteMachines(seed: RemoteMachineActorSeed, options: { active?: boolean } = {}) {
    const { active = true } = options
    const scopeKey = JSON.stringify([seed.installId, seed.workspaceId, seed.launchNonce, active])
    const scopeRef = useRef(scopeKey)
    if (scopeRef.current !== scopeKey) scopeRef.current = scopeKey
    const scope = scopeRef.current

    const clientRef = useRef<ReturnType<typeof createDesktopRemoteMachinesClient> | null>(null)
    if (!clientRef.current) clientRef.current = createDesktopRemoteMachinesClient(seed)

    const mounted = useRef(false)
    const epoch = useRef(0)
    const pending = useRef(false)
    const [snapshot, setSnapshot] = useState<DesktopRemoteSnapshot | null>(null)
    const [unavailable, setUnavailable] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<RemoteMachineBusy | null>(null)
    const [pendingRetry, setPendingRetry] = useState<RemoteMachineBusy | null>(null)

    const live = useCallback(() => mounted.current && scopeRef.current === scope && active, [scope, active])

    const sameActor = useCallback((actor: DesktopRemoteActor) => {
        const mine = clientRef.current?.actor
        return !!mine && mine.installId === actor.installId && mine.workspaceId === actor.workspaceId
            && mine.launchNonce === actor.launchNonce && mine.rendererEpoch === actor.rendererEpoch
    }, [])

    const refresh = useCallback(async () => {
        const client = clientRef.current
        if (!live() || pending.current || !client) return
        const myEpoch = ++epoch.current
        try {
            const next = await client.read()
            if (!live() || myEpoch !== epoch.current || pending.current || !sameActor(next.actor)) return
            setSnapshot(next)
            setUnavailable(false)
        } catch (error) {
            if (!live() || myEpoch !== epoch.current) return
            if (error instanceof RemoteMachineRequestError && error.code === 'authority_missing') {
                setUnavailable(true)
                setError(error.message)
                return
            }
            setUnavailable(true)
        }
    }, [live, sameActor])

    useEffect(() => {
        mounted.current = true
        epoch.current++
        setSnapshot(null)
        setUnavailable(false)
        setError(null)
        setBusy(null)
        setPendingRetry(null)
        return () => {
            mounted.current = false
            epoch.current++
            pending.current = false
            clientRef.current?.dispose()
            clientRef.current = null
        }
    }, [scope])

    useEffect(() => {
        if (!active || !clientRef.current) return
        let timer: ReturnType<typeof setTimeout> | undefined
        const tick = async () => {
            await refresh()
            if (!live()) return
            timer = setTimeout(tick, busy || snapshot?.openReceipt ? POLL_QUICK_MS : POLL_RELAXED_MS)
        }
        void tick()
        return () => {
            if (timer) clearTimeout(timer)
        }
    }, [active, refresh, live, busy, snapshot?.openReceipt])

    const runMutation = useCallback(async (kind: RemoteMachineBusyKind, operation: (requestId: string) => Promise<DesktopRemoteSnapshot>): Promise<{ snapshot: DesktopRemoteSnapshot; requestId: string } | null> => {
        const client = clientRef.current
        if (!live() || pending.current || !client) return null
        const requestId = newId()
        pending.current = true
        epoch.current++
        setBusy({ kind, requestId })
        setError(null)
        try {
            const next = await operation(requestId)
            if (!live() || !sameActor(next.actor)) return null
            setSnapshot(next)
            setPendingRetry(null)
            return { snapshot: next, requestId }
        } catch (error) {
            if (!live()) return null
            if (error instanceof RemoteMachineRequestError) {
                if (error.code === 'uncertain') {
                    setPendingRetry({ kind, requestId })
                    setError('The app could not confirm whether the machine change applied. Retrying uses the same request identity.')
                    return null
                }
                if (error.code === 'cancelled') return null
                if (error.code === 'authority_missing') {
                    setUnavailable(true)
                    setError(error.message)
                    return null
                }
                if (error.code === 'stale') {
                    toast.error(error.message)
                    void refresh()
                    return null
                }
                if (error.code === 'busy') {
                    toast.info('Another machine change is already running; wait for it to settle.')
                    return null
                }
                toast.error(error.message)
                return null
            }
            toast.error('The machine change was not confirmed. Retry the same action.')
            return null
        } finally {
            pending.current = false
            setBusy(null)
            epoch.current++
            void refresh()
        }
    }, [live, sameActor, refresh])

    const pair = useCallback((address: string, apiKey: string) => runMutation('pair', requestId => clientRef.current!.pair(address, apiKey, requestId)), [runMutation])
    const replace = useCallback((connectionId: string, expectedRevision: string, address: string, apiKey: string) => runMutation('replace', requestId => clientRef.current!.replace(connectionId, expectedRevision, address, apiKey, requestId)), [runMutation])
    const select = useCallback((connectionId: string, expectedRevision: string) => runMutation('select', requestId => clientRef.current!.select(connectionId, expectedRevision, requestId)), [runMutation])
    const remove = useCallback((connectionId: string, expectedRevision: string) => runMutation('remove', requestId => clientRef.current!.remove(connectionId, expectedRevision, requestId)), [runMutation])
    const cancel = useCallback(() => runMutation('cancel', requestId => clientRef.current!.cancel(requestId)), [runMutation])
    const recover = useCallback(() => {
        const open = snapshot?.openReceipt
        if (!open) return
        return runMutation('recover', requestId => clientRef.current!.recover(open.revision, requestId))
    }, [runMutation, snapshot?.openReceipt])

    const healthRefresh = useCallback(async () => {
        const client = clientRef.current
        if (!live() || pending.current || !client || !snapshot?.connection) return
        const { connectionId, revision } = snapshot.connection
        await runMutation('health', requestId => client.health(connectionId, revision, requestId))
    }, [live, snapshot?.connection, runMutation])

    const retry = useCallback(async () => {
        const client = clientRef.current
        if (!live() || pending.current || !client || !pendingRetry) return
        const { kind, requestId } = pendingRetry
        pending.current = true
        epoch.current++
        setBusy({ kind, requestId })
        setError(null)
        try {
            const result = await client.retry(requestId)
            if (!live()) return
            if (!result.ok) {
                if (result.code === 'uncertain') {
                    toast.info(result.message || 'Still not confirmed; try again.')
                    return
                }
                throw new RemoteMachineRequestError(result.message, result.code, result.receipt, result.authority ?? null)
            }
            if (!sameActor(result.snapshot.actor)) return
            setSnapshot(result.snapshot)
            setPendingRetry(null)
            toast.success('The machine change was confirmed.')
        } catch (error) {
            if (!live()) return
            toast.error(error instanceof Error ? error.message : 'The machine change is still unconfirmed. Try again.')
        } finally {
            pending.current = false
            setBusy(null)
            epoch.current++
            void refresh()
        }
    }, [live, pendingRetry, sameActor, refresh])

    const settle = useCallback(async () => {
        const client = clientRef.current
        if (!live() || !client || !pendingRetry) return
        try {
            const receipt = await client.receipt(pendingRetry.requestId)
            if (!live()) return
            if (receipt) {
                toast.success(`The machine change ${receipt.requiresRecovery ? 'needs recovery — use Retry recovery' : 'was confirmed'} by the server.`)
                setPendingRetry(null)
            } else {
                toast.info('The server kept no receipt for that request identity; retry the same action.')
            }
        } catch (error) {
            if (!live()) return
            toast.error(error instanceof Error ? error.message : 'Could not read the acknowledgement. Retry the same action.')
        } finally {
            void refresh()
        }
    }, [live, pendingRetry, refresh])

    return {
        snapshot,
        unavailable,
        error,
        busy,
        pendingRetry,
        refresh,
        healthRefresh,
        pair,
        replace,
        select,
        remove,
        cancel,
        recover,
        retry,
        settle,
        limits: DESKTOP_REMOTE_MACHINE_LIMITS,
    }
}
export type RemoteMachinesState = ReturnType<typeof useRemoteMachines>
export type { RemoteMachineRefusalCode }
