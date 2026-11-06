import { desktopWebSearchOutcomeSchema, type DesktopWebSearchRunIdentity } from '@rerun/contracts'
import { desktopInternalJson } from '../internal-client.js'

export async function desktopWebSearch(identity: DesktopWebSearchRunIdentity, input: unknown, stop?: AbortSignal) {
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(18_000)])
    const result = await desktopInternalJson('/api/desktop/internal/web-search', { identity, input }, signal, 67_000)
    signal.throwIfAborted()
    return desktopWebSearchOutcomeSchema.parse(result)
}
