import 'server-only'
import type { Client } from '@libsql/client'
import { getSessionMessages } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession, type DesktopAgent, type DesktopSession } from './store'
import { withoutStoppedWebhookForms } from './trigger-requests/stopped'

export type DesktopHumanRequestTarget = { db: Client; agent: DesktopAgent; session: DesktopSession }
type HistoryReader = (target: DesktopHumanRequestTarget) => ReturnType<typeof fetchHistory>
export type DesktopHumanRequestReadOptions = { signal?: AbortSignal; history?: HistoryReader }

export async function readDesktopHumanRequestTarget(runtime: DesktopRuntime, sessionId: string): Promise<DesktopHumanRequestTarget> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    await assertCoworkerNotDeleting(db, session.agentId)
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { db, agent, session }
}

async function fetchHistory(runtime: DesktopRuntime, target: DesktopHumanRequestTarget, signal?: AbortSignal) {
    const messages = await getSessionMessages(engineOf(runtime), target.agent.engineAgentId, target.session.engineSessionId, { requireSuccess: true, signal })
    if (messages.some(message => message.sessionId !== target.session.engineSessionId)) throw new Error('Foreign conversation history')
    return messages
}

// One transcript per session per summary read. Answers, Stop receipts, and ownership
// are still checked by the resolvers. Mutation paths always fetch a fresh transcript.
export function createDesktopHumanRequestHistory(runtime: DesktopRuntime, agentId: string, signal?: AbortSignal): HistoryReader {
    let snapshot: { key: string; messages: ReturnType<typeof fetchHistory> } | undefined
    return target => {
        signal?.throwIfAborted()
        if (target.agent.id !== agentId) throw new Error('Coworker ownership changed')
        const key = JSON.stringify([target.session.id, target.agent.engineAgentId, target.session.engineSessionId])
        snapshot ??= { key, messages: fetchHistory(runtime, target, signal) }
        if (snapshot.key !== key) throw new Error('Conversation ownership changed')
        return snapshot.messages
    }
}

export async function readDesktopHumanRequestMessages(runtime: DesktopRuntime, target: DesktopHumanRequestTarget, options: DesktopHumanRequestReadOptions) {
    const messages = await (options.history ? options.history(target) : fetchHistory(runtime, target, options.signal))
    return withoutStoppedWebhookForms(target.db, target.agent.id, target.session.id, messages)
}
