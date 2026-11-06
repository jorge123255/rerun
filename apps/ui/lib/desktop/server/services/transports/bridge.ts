import 'server-only'
import { SERVICE_TRANSPORT_COPY, type ServiceTransportRef } from '../../../../../../../packages/contracts/src/desktop-service-transports'
import type { createServiceTransports } from './lifecycle'
import type { TrustedRun } from './types'
export async function serviceTransportDefinitions(runtime: ReturnType<typeof createServiceTransports>, ref: ServiceTransportRef, discoveryRequestId: string, run: TrustedRun, signal: AbortSignal) {
    const snapshot = await runtime.discoverForRun(ref, discoveryRequestId, run, signal)
    if (snapshot.receipt?.outcome !== 'completed' || snapshot.observation !== 'live') return []
    const serverName = await runtime.serverName(ref, run, signal)
    return snapshot.tools.map(tool => ({
        name: `${serverName}_${tool.name}`, description: tool.description ?? tool.name, inputSchema: tool.inputSchema,
        async execute(arguments_: Record<string, unknown>, invocation: { requestId: string; toolCallId: string }, stop: AbortSignal) {
            const result = await runtime.call(ref, { ...invocation, tool: tool.name, arguments: arguments_, run }, AbortSignal.any([signal, stop]))
            return { source: snapshot.transport === 'sse' ? 'remote_mcp' as const : 'local_mcp_stdio' as const, untrusted: true as const,
                result: 'result' in result ? result.result : { isError: true, content: [{ type: 'text', text: SERVICE_TRANSPORT_COPY[result.receipt.failure ?? 'unknown'] }], structuredContent: result.receipt } }
        },
    }))
}
