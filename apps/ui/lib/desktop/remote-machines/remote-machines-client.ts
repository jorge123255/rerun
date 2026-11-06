'use client'
import {
    DESKTOP_REMOTE_MACHINE_LIMITS,
    desktopRemoteResultSchema,
    type DesktopRemoteActor,
    type DesktopRemoteCommand,
    type DesktopRemoteReceipt,
    type DesktopRemoteResult,
    type DesktopRemoteSnapshot,
} from '@rerun/contracts'

/**
 * Browser client for the desktop remote-machine service. It posts G's canonical
 * `DesktopRemoteCommand` envelopes to /api/desktop/remote-machines and parses
 * `DesktopRemoteResult` answers. The actor travels with every command; the
 * renderer epoch is minted once per panel, so a stale panel (or a response that
 * belongs to another window) fails the actor check instead of relabeling a
 * newer machine. Mutating commands keep their request id for retries: a lost
 * acknowledgement is re-issued with the exact same request identity, and the
 * same typed input is never double-applied.
 */
export const REMOTE_MACHINES_ROUTE = '/api/desktop/remote-machines'

export type RemoteMachineActorSeed = { installId: string; workspaceId: number; launchNonce: string }
export type RemoteMachineRefusalCode = 'invalid' | 'stale' | 'busy' | 'unavailable' | 'unsupported' | 'auth_needed' | 'identity_changed' | 'authority_missing' | 'uncertain' | 'cancelled' | 'storage_full' | 'network'

export class RemoteMachineRequestError extends Error {
    constructor(
        message: string,
        readonly code: RemoteMachineRefusalCode,
        readonly receipt: DesktopRemoteReceipt | null = null,
        readonly authority: string | null = null,
    ) {
        super(message)
        this.name = 'RemoteMachineRequestError'
    }
}

function newId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const parseResult = (data: unknown): DesktopRemoteResult => {
    const parsed = desktopRemoteResultSchema.safeParse(data)
    if (!parsed.success) throw new RemoteMachineRequestError('The machine service returned an unexpected answer. Retry the same action.', 'network')
    return parsed.data
}

// Only mutating commands carry typed form input worth re-issuing under the same request id; the
// retry map stays bounded by the number of changes the panel actually attempted.
const RETRYABLE_ACTIONS = new Set<DesktopRemoteCommand['action']>(['pair', 'replace', 'select', 'remove'])

export function createDesktopRemoteMachinesClient(seed: RemoteMachineActorSeed) {
    const actor: DesktopRemoteActor = { installId: seed.installId, workspaceId: seed.workspaceId, launchNonce: seed.launchNonce, rendererEpoch: newId() }
    const controllers = new Set<AbortController>()
    const retries = new Map<string, DesktopRemoteCommand>()
    let closed = false

    async function execute(command: DesktopRemoteCommand, timeoutMs: number): Promise<DesktopRemoteResult> {
        if (closed) throw new RemoteMachineRequestError('The Servers panel closed; reopen it to continue.', 'cancelled')
        if (RETRYABLE_ACTIONS.has(command.action)) retries.set(command.requestId, command)
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
            const response = await fetch(REMOTE_MACHINES_ROUTE, {
                method: 'POST',
                cache: 'no-store',
                signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(command),
            })
            const data = await response.json().catch(() => null)
            signal.throwIfAborted()
            if (closed) throw new RemoteMachineRequestError('The Servers panel closed; reopen it to continue.', 'cancelled')
            if (!response.ok) {
                const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : null
                throw new RemoteMachineRequestError(message ?? 'The app could not reach the machine service. Retry the same action.', 'network')
            }
            return parseResult(data)
        } finally {
            controllers.delete(controller)
        }
    }

    function refused(result: DesktopRemoteResult): never {
        if (result.ok) throw new RemoteMachineRequestError('The machine service did not refuse, but its answer was not read as such.', 'network')
        const message = result.message || 'The machine change was not accepted. Refresh and review it again.'
        throw new RemoteMachineRequestError(message, result.code, result.receipt, result.authority ?? null)
    }

    function unwrap(result: DesktopRemoteResult): DesktopRemoteSnapshot {
        if (!result.ok) refused(result)
        return result.snapshot
    }

    async function read(): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'read', actor, requestId: newId() }, DESKTOP_REMOTE_MACHINE_LIMITS.requestMs + 5000))
    }

    async function health(connectionId: string, expectedRevision: string, requestId = newId()): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'health', actor, requestId, connectionId, expectedRevision }, DESKTOP_REMOTE_MACHINE_LIMITS.requestMs + 5000))
    }

    async function pair(address: string, apiKey: string, requestId = newId()): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'pair', actor, requestId, connectionId: newId(), expectedRevision: 'unconfigured', address, apiKey }, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000))
    }

    async function replace(connectionId: string, expectedRevision: string, address: string, apiKey: string, requestId = newId()): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'replace', actor, requestId, connectionId, expectedRevision, address, apiKey }, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000))
    }

    async function select(connectionId: string, expectedRevision: string, requestId = newId()): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'select', actor, requestId, connectionId, expectedRevision }, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000))
    }

    async function remove(connectionId: string, expectedRevision: string, requestId = newId()): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'remove', actor, requestId, connectionId, expectedRevision, confirmation: 'Remove' }, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000))
    }

    /** Cancel the open recovery operation (the snapshot's openReceipt). */
    async function cancel(requestId = newId()): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'cancel', actor, requestId }, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000))
    }

    /** Retry the open recovery operation (the snapshot's openReceipt). */
    async function recover(expectedReceiptRevision: string, requestId = newId()): Promise<DesktopRemoteSnapshot> {
        return unwrap(await execute({ action: 'recover', actor, requestId, resume: true, expectedReceiptRevision }, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000))
    }

    /** Re-issue a lost mutation with its original request identity; retry converges instead of duplicating. */
    async function retry(requestId: string): Promise<DesktopRemoteResult> {
        const command = retries.get(requestId)
        if (!command) throw new RemoteMachineRequestError('The original request identity is gone; enter the details again.', 'network')
        return execute(command, DESKTOP_REMOTE_MACHINE_LIMITS.operationMs + 10_000)
    }

    /** Read the durable receipt for a request identity after an acknowledgement was lost. */
    async function receipt(requestId: string): Promise<DesktopRemoteReceipt | null> {
        const result = await execute({ action: 'receipt', actor, requestId: newId() }, DESKTOP_REMOTE_MACHINE_LIMITS.requestMs + 5000)
        if (!result.ok) refused(result)
        return result.receipt
    }

    return {
        actor,
        read,
        health,
        pair,
        replace,
        select,
        remove,
        cancel,
        recover,
        retry,
        receipt,
        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
            retries.clear()
        },
    }
}
export type DesktopRemoteMachinesClient = ReturnType<typeof createDesktopRemoteMachinesClient>
