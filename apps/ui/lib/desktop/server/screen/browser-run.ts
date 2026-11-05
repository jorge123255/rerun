import 'server-only'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent, findDesktopSession } from '../store'
import type { DesktopRuntime } from '../runtime'
import { desktopScreenStatus, desktopScreenTicket } from './service'

export async function desktopBrowserRun(runtime: DesktopRuntime, agentId: string, sessionId: string, signal: AbortSignal) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const [agent, session] = await Promise.all([findDesktopAgent(db, agentId), findDesktopSession(db, sessionId)])
    if (!agent || !session || session.agentId !== agentId) throw new DesktopHttpError(404, 'Conversation not found')
    const status = await desktopScreenStatus(runtime, agentId, signal)
    const [currentAgent, currentSession] = await Promise.all([findDesktopAgent(db, agentId), findDesktopSession(db, sessionId)])
    if (!currentAgent || currentAgent.engineAgentId !== agent.engineAgentId || !currentSession || currentSession.agentId !== agentId || currentSession.engineSessionId !== session.engineSessionId) {
        throw new DesktopHttpError(409, 'Conversation changed')
    }
    signal.throwIfAborted()
    const run = status.running && status.currentRun?.sessionId === session.engineSessionId ? status.currentRun : null
    return { session, trusted: run ? { agentId, sessionId, runId: run.runId, liveScreen: { kind: run.kind, site: run.site } } : null }
}
export async function desktopBrowserRunTicket(runtime: DesktopRuntime, agentId: string, sessionId: string, runId: string, signal: AbortSignal) {
    const current = await desktopBrowserRun(runtime, agentId, sessionId, signal)
    if (!current.trusted || current.trusted.runId !== runId) throw new DesktopHttpError(409, 'This run no longer owns the browser')
    return desktopScreenTicket(runtime, agentId, 'watch', signal, undefined, true, { sessionId: current.session.engineSessionId, runId })
}
