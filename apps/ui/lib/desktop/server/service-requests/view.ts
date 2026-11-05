import 'server-only'
import type { DesktopRuntime } from '../runtime'
import { desktopServiceRequestPorts, desktopServiceRequestScope } from './route-context'
import { readDesktopServiceRequest } from './service'

export async function readDesktopServiceRequestView(runtime: DesktopRuntime, sessionId: string, options: { signal?: AbortSignal } = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])])
    signal.throwIfAborted()
    const bound = await desktopServiceRequestScope(runtime, sessionId)
    signal.throwIfAborted()
    const view = await readDesktopServiceRequest(bound.db, bound.scope, desktopServiceRequestPorts(runtime, bound, signal))
    signal.throwIfAborted()
    return view
}
