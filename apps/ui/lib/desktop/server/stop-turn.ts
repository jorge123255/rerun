import 'server-only'
import { desktopRunRecovery } from '../chat-resume'
import { cancelRun, EngineRequestError, listRuns } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
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

// Mirrors Rerun's cancelSessionRuns, but never trusts the engine's filters: a candidate must be
// running, belong to this engine session, and be owned by this coworker's engine agent.
async function runningRuns({ conn, engineAgentId, engineSessionId }: Target) {
    try {
        const runs = await listRuns(conn, engineAgentId, { sessionId: engineSessionId, status: 'running' })
        return runs.filter(run => run.status === 'running' && run.sessionId === engineSessionId && run.agentId === engineAgentId)
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

export async function stopDesktopTurn(runtime: DesktopRuntime, sessionId: string): Promise<{ canceled: number; alreadyFinished: boolean }> {
    const target = await targetOf(runtime, sessionId)
    const runs = await runningRuns(target)
    let canceled = 0
    let failed = false
    for (const run of runs) {
        try {
            await cancelRun(target.conn, target.engineAgentId, run.id)
            canceled++
        } catch (cause) {
            // 404/409: the run finished (or vanished) between list and cancel — already finished.
            if (cause instanceof EngineRequestError && (cause.status === 404 || cause.status === 409)) continue
            failed = true
        }
    }
    if (failed) throw new DesktopHttpError(502, 'Could not stop this reply. Try again.')
    return { canceled, alreadyFinished: canceled === 0 }
}
