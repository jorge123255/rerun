import 'server-only'
import { serviceTransportControlSchema, SERVICE_TRANSPORT_COPY, type ServiceTransportControl } from '../../../../../../../packages/contracts/src/desktop-service-transports'
import type { createServiceTransports } from './lifecycle'
import { TransportFailure } from './compiler'
export function serviceTransportApi(runtime: ReturnType<typeof createServiceTransports>) {
    async function handle(body: unknown, authenticatedAgentId: string, signal: AbortSignal, reconcile: boolean) {
            try {
                const request = serviceTransportControlSchema.parse(body)
                if (request.agentId !== authenticatedAgentId) throw new TransportFailure('changed')
                return { ok: true as const, snapshot: await runtime[reconcile ? 'reconcile' : 'control'](request, signal) }
            } catch (error) {
                const failure = error instanceof TransportFailure ? error.code : 'unavailable'
                return { ok: false as const, failure, message: SERVICE_TRANSPORT_COPY[failure] }
            }
    }
    return { control: (body: unknown, agentId: string, signal: AbortSignal) => handle(body, agentId, signal, false), reconcile: (body: unknown, agentId: string, signal: AbortSignal) => handle(body, agentId, signal, true) }
}
export type ServiceTransportWireResult = Awaited<ReturnType<ReturnType<typeof serviceTransportApi>['control']>>
export type ServiceTransportPost = (request: ServiceTransportControl, signal: AbortSignal) => Promise<ServiceTransportWireResult>
