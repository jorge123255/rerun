import { delegationApi, type DelegationSessionAuthority } from '../../../../../../lib/desktop/server/delegation/api'
import type { DelegationRuntime } from '../../../../../../../engine/src/desktop/delegation/runtime'
export function delegationHandlers(runtime: DelegationRuntime, authority: DelegationSessionAuthority) {
    const api = delegationApi(runtime, authority)
    const handler = async (request: Request, context: { params: Promise<{ sessionId: string }> }) => api(request, (await context.params).sessionId)
    return { GET: handler, POST: handler }
}
