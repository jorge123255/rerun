import type { DesktopRemoteActor, DesktopRemoteEffectContext, DesktopRemoteEffectReceipt, DesktopRemoteIdentity, DesktopRemoteReceipt } from '../../../../../packages/contracts/src/desktop-remote-machines.js'
export type LifecycleRecord = { fingerprint: string; state: 'reserved' | 'applied'; receipt?: DesktopRemoteEffectReceipt }
export type JournalOperation = {
    receipt: DesktopRemoteReceipt; acceptedBy: DesktopRemoteActor; recoveredBy?: DesktopRemoteActor
    selectedBefore: boolean; target: DesktopRemoteIdentity | null; cancelRequested?: boolean
    lifecycleEffects?: Record<string, LifecycleRecord>
}
export type RemoteTransitionState = { installId: string; workspaceId: number; operations: JournalOperation[] }
export type RemoteTransitionStore = {
    read(): Promise<RemoteTransitionState>
    mutate(change: (state: RemoteTransitionState) => void): Promise<unknown>
}
export type RemoteTransitionName = 'freeze' | 'flush' | 'drain' | 'close' | 'bind_remote' | 'bind_local' | 'verify' | 'publish' | 'unfreeze'
export function createRemoteTransitionGate(options: {
    store: RemoteTransitionStore
    assertActor(actor: DesktopRemoteActor, context: DesktopRemoteEffectContext, signal: AbortSignal): Promise<void>
}): {
    checkOperation(context: DesktopRemoteEffectContext, signal: AbortSignal): Promise<void>
    lookupEffect(context: DesktopRemoteEffectContext, signal: AbortSignal): Promise<{state:'not_applied'} | {state:'unknown'} | {state:'applied';receipt:DesktopRemoteEffectReceipt}>
    apply(name: RemoteTransitionName, context: DesktopRemoteEffectContext, effect: (signal: AbortSignal) => Promise<DesktopRemoteEffectReceipt['value']>, signal: AbortSignal): Promise<DesktopRemoteEffectReceipt>
    close(): Promise<void>
}
