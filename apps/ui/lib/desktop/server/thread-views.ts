import 'server-only'
import type { Client } from '@libsql/client'
import { listDesktopThreadMetadata } from '@/lib/engine/client'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent, listDesktopAgents, type DesktopAgent, type DesktopSession } from './store'
import { desktopSessionView } from './views'

export async function desktopThreadViews(runtime: DesktopRuntime, db: Client, agent: DesktopAgent, sessions: DesktopSession[]) {
    const views = sessions.map(desktopSessionView)
    if (!views.some(session => session.kind === 'thread')) return views
    const metadata = await listDesktopThreadMetadata(engineOf(runtime), agent.engineAgentId, AbortSignal.timeout(1_500))
        .catch(() => [])
    if (!metadata.length || (await findDesktopAgent(db, agent.id))?.engineAgentId !== agent.engineAgentId) return views
    const threads = new Map(metadata.map(thread => [thread.id, thread]))
    const names = metadata.some(thread => thread.originAgentId) ? new Map((await listDesktopAgents(db))
        .filter(owner => owner.workspaceId === agent.workspaceId).map(owner => [owner.engineAgentId, owner.name])) : new Map<string, string>()
    return views.map((view, index) => {
        const thread = view.kind === 'thread' ? threads.get(sessions[index].engineSessionId) : undefined
        if (!thread) return view
        return {
            ...view,
            title: thread.automationResult?.title ?? view.title,
            automationOutcome: thread.automationResult?.outcome,
            source: thread.source,
            automationName: thread.automationName,
            originAgentName: thread.originAgentId ? names.get(thread.originAgentId) ?? null : null,
            runStatus: thread.runStatus,
        }
    })
}
