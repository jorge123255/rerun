import { desktopWebSearchOutcomeSchema, type DesktopWebSearchRunIdentity } from '@rerun/contracts'
import { desktopInternalJson } from '../internal-client.js'

// The app sets the real deadline for the search service in use (seconds for a search API, longer
// for one that drives a browser); this is only the outer bound.
export async function desktopWebSearch(identity: DesktopWebSearchRunIdentity, input: unknown, stop?: AbortSignal) {
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(100_000)])
    const result = await desktopInternalJson('/api/desktop/internal/web-search', { identity, input }, signal, 67_000)
    signal.throwIfAborted()
    return desktopWebSearchOutcomeSchema.parse(result)
}
