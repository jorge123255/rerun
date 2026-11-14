import 'server-only'
import { DesktopHttpError } from '../auth'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent, findDesktopSession } from '../store'
import { describeDesktopServiceRequestCatalog, prepareDesktopServiceSeal, readDesktopServiceConnections, readDesktopServiceVaultOffers, readDesktopServiceSource, sendDesktopServiceFollowUp } from './adapters'
import { ensureDesktopServiceSuggestionSchema } from './schema'

export async function desktopServiceRequestScope(runtime: DesktopRuntime, sessionId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensureDesktopServiceSuggestionSchema(db)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    await assertCoworkerNotDeleting(db, session.agentId)
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { db, session, agent, scope: { agentId: agent.id, sessionId: session.id, enabled: agent.enabled } }
}

export function desktopServiceRequestPorts(runtime: DesktopRuntime, bound: Awaited<ReturnType<typeof desktopServiceRequestScope>>, signal: AbortSignal) {
    return {
        source: () => readDesktopServiceSource(runtime, bound.agent, bound.session, signal),
        catalog: (slug: string) => describeDesktopServiceRequestCatalog(slug),
        installations: () => readDesktopServiceConnections(runtime, bound.agent.id, signal),
        vaultAccounts: () => readDesktopServiceVaultOffers(runtime, bound.agent.id, signal),
        prepareSeal: () => prepareDesktopServiceSeal(runtime, bound.agent.id, signal),
        send: (receipt: Parameters<typeof sendDesktopServiceFollowUp>[3], mode: 'send' | 'replay') => sendDesktopServiceFollowUp(runtime, bound.agent, bound.session, receipt, mode),
    }
}
