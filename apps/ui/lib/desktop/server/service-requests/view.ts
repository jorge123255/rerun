import 'server-only'
import type { DesktopRuntime } from '../runtime'
import { desktopServiceRequestPorts, desktopServiceRequestScope } from './route-context'
import { readDesktopServiceRequest, readPendingDesktopServiceToolCall } from './service'

export async function readDesktopServiceRequestView(runtime: DesktopRuntime, sessionId: string, options: { signal?: AbortSignal } = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])])
    signal.throwIfAborted()
    const bound = await desktopServiceRequestScope(runtime, sessionId)
    signal.throwIfAborted()
    const view = await readDesktopServiceRequest(bound.db, bound.scope, desktopServiceRequestPorts(runtime, bound, signal))
    signal.throwIfAborted()
    return view
}

export async function readPendingDesktopServiceToolCallView(runtime: DesktopRuntime, sessionId: string, options: { signal?: AbortSignal } = {}): Promise<string | null> {
    const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(options.signal ? [options.signal] : [])])
    signal.throwIfAborted()
    const bound = await desktopServiceRequestScope(runtime, sessionId)
    return readPendingDesktopServiceToolCall(bound.db, bound.scope, desktopServiceRequestPorts(runtime, bound, signal))
}
