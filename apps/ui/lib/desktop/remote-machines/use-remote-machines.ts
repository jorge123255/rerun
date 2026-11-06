'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DESKTOP_REMOTE_MACHINE_LIMITS, type DesktopRemoteMachineBridge, type DesktopRemoteSnapshot } from '@rerun/contracts'
import { createDesktopRemoteMachinesClient, RemoteMachineRequestError, type DesktopRemoteMachinesClient, type RemoteMachineActorSeed } from './remote-machines-client'

const POLL_RELAXED_MS = 3000
const POLL_QUICK_MS = 1200
export type RemoteMachineBusyKind = 'pair' | 'replace' | 'remove' | 'select' | 'health' | 'cancel' | 'recover' | 'retry'
export type RemoteMachineBusy = { kind: RemoteMachineBusyKind; requestId: string }
type PanelState = { scope: string; snapshot: DesktopRemoteSnapshot | null; unavailable: boolean; error: string | null; busy: RemoteMachineBusy | null; pendingRetry: RemoteMachineBusy | null }
const empty = (scope: string): PanelState => ({ scope, snapshot: null, unavailable: false, error: null, busy: null, pendingRetry: null })
const newId = () => crypto.randomUUID()

/** Every open panel uses native's exact actor lease; viewing and polling are observational. */
export function useRemoteMachines(actor: RemoteMachineActorSeed, options: { active?: boolean; bridge?: DesktopRemoteMachineBridge } = {}) {
    const { active = true, bridge } = options
    const scope = JSON.stringify([actor.installId, actor.workspaceId, actor.launchNonce, actor.rendererEpoch, active])
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const clientRef = useRef<DesktopRemoteMachinesClient | null>(null)
    const readEpoch = useRef(0), operationEpoch = useRef(0), pending = useRef(false)
    const [state, setState] = useState<PanelState>(() => empty(scope))
    const stateRef = useRef(state)
    stateRef.current = state
    const current = useCallback((client: DesktopRemoteMachinesClient) => active && scopeRef.current === scope && clientRef.current === client, [scope, active])
    const update = useCallback((change: (value: PanelState) => PanelState) => setState(previous => previous.scope === scope ? change(previous) : previous), [scope])

    const refresh = useCallback(async () => {
        const client = clientRef.current
        if (!client || !current(client) || pending.current) return
        const epoch = ++readEpoch.current
        try {
            const snapshot = await client.read()
            if (!current(client) || pending.current || epoch !== readEpoch.current) return
            update(previous => ({ ...previous, snapshot, unavailable: false, error: previous.pendingRetry ? previous.error : null }))
        } catch (error) {
            if (!current(client) || epoch !== readEpoch.current) return
            update(previous => ({ ...previous, unavailable: !previous.snapshot || error instanceof RemoteMachineRequestError && error.code === 'authority_missing', error: error instanceof RemoteMachineRequestError ? error.message : 'Saved server state could not be read. Refresh to retry.' }))
        }
    }, [current, update])

    useEffect(() => {
        if (!active) { setState(empty(scope)); return }
        const client = createDesktopRemoteMachinesClient(actor, { bridge })
        clientRef.current = client
        pending.current = false
        readEpoch.current++
        operationEpoch.current++
        setState(empty(scope))
        let stopped = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const tick = async () => {
            await refresh()
            if (stopped || !current(client)) return
            const latest = stateRef.current
            timer = setTimeout(tick, pending.current || latest.scope === scope && latest.snapshot?.openReceipt ? POLL_QUICK_MS : POLL_RELAXED_MS)
        }
        void tick()
        return () => {
            stopped = true
            if (timer) clearTimeout(timer)
            client.dispose()
            if (clientRef.current === client) {
                clientRef.current = null
                pending.current = false
                readEpoch.current++
                operationEpoch.current++
            }
        }
    }, [scope, active, bridge, refresh, current])

    const runMutation = useCallback(async (kind: RemoteMachineBusyKind, work: (client: DesktopRemoteMachinesClient, requestId: string) => Promise<DesktopRemoteSnapshot>, requestId = newId()) => {
        const client = clientRef.current
        if (!client || !current(client) || pending.current && kind !== 'cancel') return null
        const latest = stateRef.current
        if (latest.scope === scope && latest.pendingRetry && !['cancel', 'recover'].includes(kind)) {
            update(previous => ({ ...previous, error: 'Check the previous request before starting another server change.' }))
            return null
        }
        const epoch = ++operationEpoch.current
        readEpoch.current++
        pending.current = true
        update(previous => ({ ...previous, busy: { kind, requestId }, error: null }))
        try {
            const snapshot = await work(client, requestId)
            if (!current(client) || epoch !== operationEpoch.current) return null
            update(previous => ({ ...previous, snapshot, unavailable: false, pendingRetry: null }))
            return { snapshot, requestId }
        } catch (error) {
            if (!current(client) || epoch !== operationEpoch.current) return null
            const known = error instanceof RemoteMachineRequestError ? error : new RemoteMachineRequestError('The server change was not confirmed. Check this same request.', 'uncertain')
            const uncertain = known.code === 'uncertain' || known.code === 'network' || known.receipt?.requiresRecovery === true
            update(previous => ({ ...previous, error: known.message, unavailable: known.code === 'authority_missing', pendingRetry: uncertain ? { kind, requestId } : null }))
            return null
        } finally {
            if (current(client) && epoch === operationEpoch.current) {
                pending.current = false
                update(previous => ({ ...previous, busy: null }))
                void refresh()
            }
        }
    }, [current, scope, update, refresh])

    const pair = useCallback((address: string, apiKey: string) => runMutation('pair', (client, id) => client.pair(address, apiKey, id)), [runMutation])
    const replace = useCallback((connectionId: string, revision: string, address: string, apiKey: string) => runMutation('replace', (client, id) => client.replace(connectionId, revision, address, apiKey, id)), [runMutation])
    const select = useCallback((connectionId: string, revision: string) => runMutation('select', (client, id) => client.select(connectionId, revision, id)), [runMutation])
    const remove = useCallback((connectionId: string, revision: string) => runMutation('remove', (client, id) => client.remove(connectionId, revision, id)), [runMutation])
    const cancel = useCallback(() => {
        const latest = stateRef.current
        const requestId = latest.scope === scope ? latest.busy?.requestId ?? latest.pendingRetry?.requestId ?? latest.snapshot?.openReceipt?.requestId : undefined
        if (!requestId) return Promise.resolve(null)
        return runMutation('cancel', client => client.cancel(requestId), requestId)
    }, [scope, runMutation])
    const recover = useCallback(() => {
        const latest = stateRef.current, receipt = latest.scope === scope ? latest.snapshot?.openReceipt : null
        if (!receipt) return Promise.resolve(null)
        return runMutation('recover', client => client.recover(receipt.revision, receipt.requestId), receipt.requestId)
    }, [scope, runMutation])
    const healthRefresh = useCallback(() => {
        const latest = stateRef.current, connection = latest.scope === scope ? latest.snapshot?.connection : null
        if (!connection) return Promise.resolve(null)
        return runMutation('health', (client, id) => client.health(connection.connectionId, connection.revision, id))
    }, [scope, runMutation])
    const retry = useCallback(async () => {
        const client = clientRef.current, latest = stateRef.current
        const retry = latest.scope === scope ? latest.pendingRetry : null
        if (!client || !retry || !current(client) || pending.current) return
        const epoch = ++operationEpoch.current
        readEpoch.current++
        pending.current = true
        update(previous => ({ ...previous, busy: { kind: 'retry', requestId: retry.requestId }, error: null }))
        try {
            const result = await client.retry(retry.requestId)
            if (!current(client) || epoch !== operationEpoch.current) return
            if (!result.ok) throw new RemoteMachineRequestError(result.message, result.code, result.receipt, result.authority ?? null)
            update(previous => ({ ...previous, snapshot: result.snapshot, unavailable: false, pendingRetry: null }))
        } catch (error) {
            if (current(client) && epoch === operationEpoch.current) update(previous => ({ ...previous, error: error instanceof RemoteMachineRequestError ? error.message : 'The original server request is still unconfirmed. Check its acknowledgement.' }))
        } finally {
            if (current(client) && epoch === operationEpoch.current) { pending.current = false; update(previous => ({ ...previous, busy: null })); void refresh() }
        }
    }, [scope, current, update, refresh])
    const settle = useCallback(async () => {
        const epoch = operationEpoch.current
        const client = clientRef.current, latest = stateRef.current
        const retry = latest.scope === scope ? latest.pendingRetry : null
        if (!client || !retry || !current(client) || pending.current) return
        try {
            const receipt = await client.receipt(retry.requestId)
            if (!current(client) || epoch !== operationEpoch.current) return
            update(previous => ({ ...previous, pendingRetry: receipt && !receipt.requiresRecovery ? null : previous.pendingRetry,
                error: !receipt ? 'The original request has no saved acknowledgement. Retry that same request.' : receipt.requiresRecovery ? 'The saved server change needs recovery. Use Retry recovery.' : receipt.phase === 'published' ? null : 'The saved server change did not finish. Review it before starting another.' }))
        } catch (error) {
            if (current(client) && epoch === operationEpoch.current) update(previous => ({ ...previous, error: error instanceof RemoteMachineRequestError ? error.message : 'The original acknowledgement could not be read.' }))
        } finally { if (current(client) && epoch === operationEpoch.current) void refresh() }
    }, [scope, current, update, refresh])
    const visible = state.scope === scope ? state : empty(scope)
    return { snapshot: visible.snapshot, unavailable: visible.unavailable, error: visible.error, busy: visible.busy, pendingRetry: visible.pendingRetry,
        refresh, healthRefresh, pair, replace, select, remove, cancel, recover, retry, settle,
        actor, limits: DESKTOP_REMOTE_MACHINE_LIMITS }
}
export type { RemoteMachineActorSeed }

export type RemoteMachinesState = ReturnType<typeof useRemoteMachines>
