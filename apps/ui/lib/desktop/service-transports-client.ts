'use client'
import { serviceTransportSnapshotSchema, serviceTransportControlSchema, type ServiceTransportRef, type ServiceTransportControl, type ServiceTransportSnapshot } from '../../../../packages/contracts/src/desktop-service-transports'
export type ServiceTransportReply = { ok: true; snapshot: ServiceTransportSnapshot } | { ok: false; failure: string; message: string }
export type ServiceTransportJournal = {
    read(ref: ServiceTransportRef): Promise<ServiceTransportControl | null>
    put(request: ServiceTransportControl): Promise<void>
    clear(request: ServiceTransportControl): Promise<void>
}
export type ServiceTransportClient = ReturnType<typeof createServiceTransportClient>
export function createServiceTransportClient(ports: {
    post(request: ServiceTransportControl, signal: AbortSignal): Promise<ServiceTransportReply>
    reconcile(request: ServiceTransportControl, signal: AbortSignal): Promise<ServiceTransportReply>
    journal: ServiceTransportJournal; uuid(): string
}) {
    const localAttempts = new Map<string, ServiceTransportControl>()
    const slot = (ref: ServiceTransportRef) => JSON.stringify([ref.agentId, ref.installationId])
    async function pending(ref: ServiceTransportRef) { return localAttempts.get(slot(ref)) ?? await ports.journal.read(ref) }
    async function replace(ref: ServiceTransportRef, action: 'stop' | 'reconnect') {
        const old = await pending(ref)
        if (old && old.action !== action) { await ports.journal.clear(old); localAttempts.delete(slot(ref)) }
        return action
    }
    function checked(ref: ServiceTransportRef, reply: ServiceTransportReply) {
        if (!reply.ok) throw new Error('Connection acknowledgement unavailable. Refresh or reconcile this attempt.')
        const snapshot = serviceTransportSnapshotSchema.parse(reply.snapshot)
        if (snapshot.ref.agentId !== ref.agentId || snapshot.ref.key !== ref.key || snapshot.ref.installationId !== ref.installationId || snapshot.ref.revision !== ref.revision) throw new Error('The selected account changed.')
        return snapshot
    }
    async function finish(request: ServiceTransportControl, reply: ServiceTransportReply, signal: AbortSignal) {
        signal.throwIfAborted()
        const snapshot = checked(request, reply)
        if (!snapshot.receipt || snapshot.receipt.requestId !== request.requestId || snapshot.receipt.action !== request.action || snapshot.receipt.ref.agentId !== request.agentId || snapshot.receipt.ref.installationId !== request.installationId || snapshot.receipt.ref.key !== request.key || snapshot.receipt.ref.revision !== request.revision) throw new Error('Acknowledgement identity is unavailable.')
        if (snapshot.receipt.outcome === 'completed' || snapshot.receipt.outcome === 'refused') { await ports.journal.clear(request); signal.throwIfAborted(); if (localAttempts.get(slot(request))?.requestId === request.requestId) localAttempts.delete(slot(request)) }
        return snapshot
    }
    return {
        pending,
        async status(ref: ServiceTransportRef, signal: AbortSignal) {
            const request = serviceTransportControlSchema.parse({ ...ref, requestId: ports.uuid(), action: 'status' })
            return checked(ref, await ports.post(request, signal))
        },
        async perform(ref: ServiceTransportRef, action: Exclude<ServiceTransportControl['action'], 'status'>, signal: AbortSignal) {
            const saved = await pending(ref)
            const request = serviceTransportControlSchema.parse(saved ?? { ...ref, requestId: ports.uuid(), action })
            if (request.agentId !== ref.agentId || request.installationId !== ref.installationId || request.key !== ref.key || request.revision !== ref.revision || request.action !== action) throw new Error('Reconcile the previous attempt before starting another operation.')
            localAttempts.set(slot(ref), request)
            await ports.journal.put(request)
            signal.throwIfAborted()
            return finish(request, await ports.post(request, signal), signal)
        },
        async stop(ref: ServiceTransportRef, signal: AbortSignal) { await replace(ref, 'stop'); return this.perform(ref, 'stop', signal) },
        async retryConnection(ref: ServiceTransportRef, signal: AbortSignal) {
            const old = await pending(ref)
            if (old) { await ports.journal.clear(old); localAttempts.delete(slot(ref)) }
            return this.perform(ref, 'reconnect', signal)
        },
        async reconcile(request: ServiceTransportControl, signal: AbortSignal) { return finish(request, await ports.reconcile(request, signal), signal) },
    }
}
