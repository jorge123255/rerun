import 'server-only'
import { desktopRunRecovery } from '../chat-resume'
import { cancelRun, EngineRequestError, listRuns } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { withDesktopSecretSessionTransition } from './secret-requests/lifecycle'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession } from './store'

type Target = { conn: ReturnType<typeof engineOf>; engineAgentId: string; engineSessionId: string }

async function targetOf(runtime: DesktopRuntime, sessionId: string): Promise<Target> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { conn: engineOf(runtime), engineAgentId: agent.engineAgentId, engineSessionId: session.engineSessionId }
}

// Never trust the engine's filters. Stop requires the exact run, session and owner.
async function hasRunningReply({ conn, engineAgentId, engineSessionId }: Target, runId: string) {
    try {
        const runs = await listRuns(conn, engineAgentId, { sessionId: engineSessionId, status: 'running' })
        return runs.some(run => run.id === runId && run.status === 'running' && run.sessionId === engineSessionId && run.agentId === engineAgentId)
    } catch {
        throw new DesktopHttpError(502, 'Could not stop this reply. Try again.')
    }
}

export async function readDesktopTurnRunning(runtime: DesktopRuntime, sessionId: string) {
    const target = await targetOf(runtime, sessionId)
    try {
        const runs = await listRuns(target.conn, target.engineAgentId, { sessionId: target.engineSessionId, limit: 50 })
        const recovery = desktopRunRecovery(runs, target.engineAgentId, target.engineSessionId)
        return { running: !!recovery.activeRunId, runId: recovery.activeRunId, failedRunId: recovery.failedRunId, failedRunError: recovery.lastError, runVersion: recovery.runVersion }
    } catch { throw new DesktopHttpError(502, 'Could not read this reply’s status. Try again.') }
}

export async function stopDesktopTurn(runtime: DesktopRuntime, sessionId: string, runId: string): Promise<{ canceled: number; alreadyFinished: boolean }> {
    const target = await targetOf(runtime, sessionId)
    if (!await hasRunningReply(target, runId)) return { canceled: 0, alreadyFinished: true }
    return withDesktopSecretSessionTransition(runtime, sessionId, async () => {
        try {
            await cancelRun(target.conn, target.engineAgentId, runId)
            return { canceled: 1, alreadyFinished: false }
        } catch (cause) {
            // 404/409: the run finished (or vanished) between list and cancel — already finished.
            if (cause instanceof EngineRequestError && (cause.status === 404 || cause.status === 409)) return { canceled: 0, alreadyFinished: true }
            throw new DesktopHttpError(502, 'Could not stop this reply. Try again.')
        }
    })
}
