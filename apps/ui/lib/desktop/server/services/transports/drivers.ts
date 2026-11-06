import 'server-only'
import type { createSseRuntime } from '../../mcp-sse/runtime'
import type { DesktopMcpSseRef } from '../../../../../../../packages/contracts/src/desktop-mcp-sse'
import type { TransportAuthority, TransportDriver, ResolvedTransport, TrustedRun } from './types'
import { TransportFailure } from './compiler'
import { wait } from '../../mcp-sse/errors'
export type SseAccountBinding = {
    reference(authority: TransportAuthority, material?: ResolvedTransport): Promise<DesktopMcpSseRef>
    releaseServerRun(ref: DesktopMcpSseRef, run: TrustedRun, signal: AbortSignal): Promise<void>
}
export function canonicalSseServiceDriver(runtime: ReturnType<typeof createSseRuntime>, binding: SseAccountBinding): TransportDriver {
    async function reference(a: TransportAuthority, material?: ResolvedTransport) {
        const ref = await binding.reference(a, material)
        if (ref.agentId !== a.ref.agentId || ref.name !== a.plan.serverName) throw new TransportFailure('changed')
        return ref
    }
    return {
        async status(a, signal) {
            const value = await runtime.status(await reference(a), signal)
            const code = value.failure === 'auth-needed' ? 'auth-needed' as const : value.failure === 'unsupported' ? 'unsupported' as const : value.failure === 'close-unconfirmed' ? 'close-unconfirmed' as const : value.failure ? 'unavailable' as const : undefined
            return { state: value.state === 'connected' ? 'healthy' : value.state === 'closing' ? 'closing' : value.state === 'disconnected' ? 'disconnected' : code ? 'unavailable' : 'unchecked', tools: value.tools, ...(code ? { failure: code } : {}) }
        },
        async discover(context, requestId, mode, run) {
            await context.guard()
            const ref = await reference(context.authority, context.material)
            await context.guard()
            const value = mode === 'run' && run ? await runtime.tools(ref, run, context.signal)
                : mode === 'probe' ? await runtime.probe({ ...ref, requestId, operation: 'probe' }, context.signal)
                : await runtime.connect({ ...ref, requestId, operation: 'connect' }, context.signal)
            if (value.state !== 'connected') throw new TransportFailure(value.failure === 'auth-needed' ? 'auth-needed' : value.failure === 'unsupported' ? 'unsupported' : value.failure === 'close-unconfirmed' ? 'close-unconfirmed' : 'unavailable')
            await context.guard()
            return { tools: value.tools, observation: mode === 'probe' ? 'probe' : 'live' }
        },
        async call(context, invocation) {
            await context.guard()
            const ref = await reference(context.authority, context.material)
            await context.guard()
            const value = await runtime.call({ ...ref, requestId: invocation.requestId, sessionId: invocation.run.sessionId, runId: invocation.run.runId, toolCallId: invocation.toolCallId, tool: invocation.tool, arguments: invocation.arguments }, invocation.run, context.signal)
            if (value.status !== 'completed') throw new TransportFailure('unknown')
            await context.guard(); return value.result
        },
        async drain(a, signal) { const ref = await reference(a); await wait(runtime.dispose(ref.agentId, ref.serverId), signal) },
        async releaseRun(a, run, signal) { await binding.releaseServerRun(await reference(a), run, signal) },
    }
}
// Root adapts its existing stdio runtime to this exact-account seam. There is no spawn or pool here.
export type CanonicalProgramLifecycle = {
    status(a: TransportAuthority, signal: AbortSignal): ReturnType<TransportDriver['status']>
    discover: TransportDriver['discover']; call: TransportDriver['call']; drain: TransportDriver['drain']; releaseRun: TransportDriver['releaseRun']
}
export function canonicalProgramServiceDriver(runtime: CanonicalProgramLifecycle): TransportDriver {
    return {
        status: (a, signal) => runtime.status(a, signal),
        async discover(context, requestId, mode, run) { await context.guard(); const value = await runtime.discover(context, requestId, mode, run); await context.guard(); return value },
        async call(context, invocation) { await context.guard(); const result = await runtime.call(context, invocation); await context.guard(); return result },
        drain: (a, signal) => runtime.drain(a, signal), releaseRun: (a, run, signal) => runtime.releaseRun(a, run, signal),
    }
}
