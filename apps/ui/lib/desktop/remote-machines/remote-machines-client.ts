'use client'
import {
    DESKTOP_REMOTE_MACHINE_LIMITS,
    desktopRemoteActorSchema,
    desktopRemoteResultSchema,
    type DesktopRemoteActor,
    type DesktopRemoteCommand,
    type DesktopRemoteMachineBridge,
    type DesktopRemoteReceipt,
    type DesktopRemoteResult,
    type DesktopRemoteSnapshot,
} from '@rerun/contracts'

export const REMOTE_MACHINES_ROUTE = '/api/desktop/remote-machines'
export type RemoteMachineActorSeed = DesktopRemoteActor
export type RemoteMachineRefusalCode = 'invalid' | 'stale' | 'busy' | 'unavailable' | 'unsupported' | 'auth_needed' | 'identity_changed' | 'authority_missing' | 'uncertain' | 'cancelled' | 'storage_full' | 'network'
export type RemoteMachineClientOptions = { bridge?: DesktopRemoteMachineBridge }

export class RemoteMachineRequestError extends Error {
    constructor(message: string, readonly code: RemoteMachineRefusalCode, readonly receipt: DesktopRemoteReceipt | null = null, readonly authority: string | null = null) {
        super(message)
        this.name = 'RemoteMachineRequestError'
    }
}

function newId(): string {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') throw new RemoteMachineRequestError('This workspace window could not create a request. Reopen it to continue.', 'unavailable')
    return crypto.randomUUID()
}
const sameActor = (a: DesktopRemoteActor, b: DesktopRemoteActor) => a.installId === b.installId && a.workspaceId === b.workspaceId && a.launchNonce === b.launchNonce && a.rendererEpoch === b.rendererEpoch
const MUTATIONS = new Set<DesktopRemoteCommand['action']>(['pair', 'replace', 'select', 'remove', 'health', 'recover', 'cancel'])

/** The complete actor lease is issued by native main, never minted by the renderer. */
export function createDesktopRemoteMachinesClient(seed: RemoteMachineActorSeed, options: RemoteMachineClientOptions = {}) {
    const actor = Object.freeze(desktopRemoteActorSchema.parse(seed))
    const controllers = new Set<AbortController>()
    const retries = new Map<string, DesktopRemoteCommand>()
    let closed = false

    async function execute(input: DesktopRemoteCommand, timeoutMs: number): Promise<DesktopRemoteResult> {
        if (closed) throw new RemoteMachineRequestError('The Servers panel closed; reopen it to continue.', 'cancelled')
        const command = structuredClone(input)
        const mutating = MUTATIONS.has(command.action)
        if (mutating) {
            if (!retries.has(command.requestId) && retries.size >= DESKTOP_REMOTE_MACHINE_LIMITS.receipts) throw new RemoteMachineRequestError('Resolve the previous server requests before starting another.', 'storage_full')
            if (!retries.has(command.requestId)) retries.set(command.requestId, command)
        }
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
            const receive = async () => {
                if (options.bridge) return options.bridge.execute(command, signal)
                const response = await fetch(REMOTE_MACHINES_ROUTE, {
                    method: 'POST', cache: 'no-store', signal,
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
                })
                if (!response.ok) throw new RemoteMachineRequestError('The server request was not confirmed. Check this same request before retrying.', mutating ? 'uncertain' : 'network')
                return response.json().catch(() => null)
            }
            let abort = () => {}
            let data: unknown
            try {
                data = await Promise.race([receive(), new Promise<never>((_, reject) => {
                    abort = () => reject(new RemoteMachineRequestError('The server request was not confirmed. Check this same request before retrying.', mutating ? 'uncertain' : 'network'))
                    signal.addEventListener('abort', abort, { once: true })
                    if (signal.aborted) abort()
                })])
            } finally { signal.removeEventListener('abort', abort) }
            signal.throwIfAborted()
            if (closed) throw new RemoteMachineRequestError('The Servers panel closed; reopen it to continue.', mutating ? 'uncertain' : 'cancelled')
            const parsed = desktopRemoteResultSchema.safeParse(data)
            if (!parsed.success) throw new RemoteMachineRequestError('The machine service returned an unexpected answer. Check this same request before retrying.', mutating ? 'uncertain' : 'network')
            const result = parsed.data
            if (result.ok && !sameActor(result.snapshot.actor, actor)) throw new RemoteMachineRequestError('The acknowledgement belongs to another workspace window. Reconcile this same request.', mutating ? 'uncertain' : 'stale')
            if (result.receipt && (result.receipt.installId !== actor.installId || result.receipt.workspaceId !== actor.workspaceId || result.receipt.requestId !== command.requestId
                || 'connectionId' in command && (result.receipt.connectionId !== command.connectionId || result.receipt.expectedRevision !== command.expectedRevision)
                || ['pair', 'replace', 'select', 'remove', 'health'].includes(command.action) && result.receipt.kind !== command.action)) {
                throw new RemoteMachineRequestError('The acknowledgement belongs to another server request.', mutating ? 'uncertain' : 'stale')
            }
            if (mutating && result.ok && !result.receipt) throw new RemoteMachineRequestError('This server change has no exact acknowledgement. Check this same request before retrying.', 'uncertain')
            if (mutating && !result.receipt?.requiresRecovery && (result.ok || result.code !== 'uncertain')) retries.delete(command.requestId)
            return result
        } catch (error) {
            if (error instanceof RemoteMachineRequestError) throw error
            throw new RemoteMachineRequestError(mutating ? 'The server change was not confirmed. Check this same request before retrying.' : 'The app could not read the saved server state.', mutating ? 'uncertain' : 'network')
        } finally { controllers.delete(controller) }
    }
    function unwrap(result: DesktopRemoteResult): DesktopRemoteSnapshot {
        if (!result.ok) throw new RemoteMachineRequestError(result.message, result.code, result.receipt, result.authority ?? null)
        return result.snapshot
    }
    const request = async (command: DesktopRemoteCommand, mutating = false) => unwrap(await execute(command, mutating ? DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000 : DESKTOP_REMOTE_MACHINE_LIMITS.requestMs + 5000))
    return {
        actor,
        read: () => request({ action: 'read', actor, requestId: newId() }),
        health: (connectionId: string, expectedRevision: string, requestId = newId()) => request({ action: 'health', actor, requestId, connectionId, expectedRevision }, true),
        pair: (address: string, apiKey: string, requestId = newId()) => request({ action: 'pair', actor, requestId, connectionId: newId(), expectedRevision: 'unconfigured', address, apiKey }, true),
        replace: (connectionId: string, expectedRevision: string, address: string, apiKey: string, requestId = newId()) => request({ action: 'replace', actor, requestId, connectionId, expectedRevision, address, apiKey }, true),
        select: (connectionId: string, expectedRevision: string, requestId = newId()) => request({ action: 'select', actor, requestId, connectionId, expectedRevision }, true),
        remove: (connectionId: string, expectedRevision: string, requestId = newId()) => request({ action: 'remove', actor, requestId, connectionId, expectedRevision, confirmation: 'Remove' }, true),
        cancel: (requestId: string) => request({ action: 'cancel', actor, requestId }, true),
        recover: (expectedReceiptRevision: string, requestId: string) => request({ action: 'recover', actor, requestId, resume: true, expectedReceiptRevision }, true),
        async retry(requestId: string): Promise<DesktopRemoteResult> {
            const command = retries.get(requestId)
            if (!command) throw new RemoteMachineRequestError('Read the saved request and use its recovery action; its original form is no longer in this panel.', 'unavailable')
            return execute(command, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000)
        },
        async receipt(requestId: string): Promise<DesktopRemoteReceipt | null> {
            const result = await execute({ action: 'receipt', actor, requestId }, DESKTOP_REMOTE_MACHINE_LIMITS.requestMs + 5000)
            if (!result.ok) throw new RemoteMachineRequestError(result.message, result.code, result.receipt, result.authority ?? null)
            if (result.receipt && !result.receipt.requiresRecovery) retries.delete(requestId)
            return result.receipt
        },
        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
            retries.clear()
        },
    }
}
export type DesktopRemoteMachinesClient = ReturnType<typeof createDesktopRemoteMachinesClient>
