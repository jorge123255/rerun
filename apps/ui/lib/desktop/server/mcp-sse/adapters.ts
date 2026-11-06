import 'server-only'
import type { McpRunIdentity } from '../mcp/bridge'
import { desktopMcpSseRequestSchema, type DesktopMcpSseRef, type DesktopMcpSseRequest, type DesktopMcpSseOutcome, type DesktopMcpSseSnapshot } from '@rerun/contracts'
import type { createSseRuntime } from './runtime'
import { safeFailure } from './errors'

export function sseOutcomeToolResult(outcome: DesktopMcpSseOutcome) {
    return outcome.status === 'completed' ? outcome.result! : {
        isError: true, content: [{ type: 'text', text: outcome.message ?? 'SSE call acknowledgement is unknown; never automatically repeat it.' }],
        structuredContent: { status: outcome.status, requestId: outcome.requestId, failure: outcome.failure ?? 'unavailable' },
    }
}
export function sseControlAdapter(runtime: ReturnType<typeof createSseRuntime>) {
    return async (input: DesktopMcpSseRequest, signal: AbortSignal): Promise<DesktopMcpSseSnapshot> => {
        const request = desktopMcpSseRequestSchema.parse(input)
        const ref = { agentId: request.agentId, serverId: request.serverId, name: request.name, expectedRevision: request.expectedRevision }
        try {
            if (request.operation === 'status') return await runtime.status(ref, signal)
            return await runtime[request.operation](request, signal)
        } catch (error) {
            const failure = safeFailure(error)
            return { ...ref, transport: 'sse', endpointDisplay: '', tools: [], failure: failure.code, message: failure.message,
                state: failure.code === 'auth-needed' ? 'needs_auth' : failure.code === 'unsupported' ? 'unsupported' : failure.code === 'close-unconfirmed' ? 'closing' : 'error' }
        }
    }
}
export async function sseToolDefinitions(runtime: ReturnType<typeof createSseRuntime>, ref: DesktopMcpSseRef, run: McpRunIdentity, signal: AbortSignal) {
    const snapshot = await runtime.tools(ref, run, signal)
    return snapshot.tools.map(tool => ({
        name: `${ref.name}_${tool.name}`, description: tool.description ?? tool.name, inputSchema: tool.inputSchema,
        async execute(arguments_: Record<string, unknown>, invocation: { requestId: string; toolCallId: string }, stop: AbortSignal) {
            const outcome = await runtime.call({ ...ref, ...invocation, sessionId: run.sessionId, runId: run.runId, tool: tool.name, arguments: arguments_ }, run, AbortSignal.any([signal, stop]))
            return { source: 'remote_mcp' as const, untrusted: true as const, result: sseOutcomeToolResult(outcome) }
        },
    }))
}
