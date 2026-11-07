import 'server-only'
import { listRuns, reconnectRun } from '@/lib/engine/client'
import type { EngineRun } from '@/lib/engine/types'
import { DesktopHttpError } from './auth'
import { desktopResumeDecision, desktopRunRecovery, type DesktopOwnedRun, type DesktopRunRecovery } from '../chat-resume'
import { openDesktopDatabase } from './database'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession } from './store'
import type { DesktopRuntime } from './runtime'

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

function ownedRun(run: EngineRun): DesktopOwnedRun {
    return { id: run.id, agentId: run.agentId, sessionId: run.sessionId, status: run.status, error: run.error, startedAt: run.startedAt }
}

async function ownedRuns(runtime: DesktopRuntime, sessionId: string): Promise<{ engineAgentId: string; engineSessionId: string; runs: DesktopOwnedRun[] }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    let runs: EngineRun[]
    try {
        runs = await listRuns(engineOf(runtime), agent.engineAgentId, { sessionId: session.engineSessionId, limit: 50 })
    } catch {
        throw new DesktopHttpError(503, 'This reply’s status is unavailable. Try again.')
    }
    return { engineAgentId: agent.engineAgentId, engineSessionId: session.engineSessionId, runs: runs.map(ownedRun) }
}

export async function readDesktopRunRecovery(runtime: DesktopRuntime, sessionId: string): Promise<DesktopRunRecovery & { runsUnavailable: boolean }> {
    try {
        const { engineAgentId, engineSessionId, runs } = await ownedRuns(runtime, sessionId)
        return { ...desktopRunRecovery(runs, engineAgentId, engineSessionId), runsUnavailable: false }
    } catch (error) {
        if (error instanceof DesktopHttpError && error.status === 404) throw error
        return { activeRunId: null, lastError: null, runsUnavailable: true }
    }
}

export type DesktopResumeResult =
    | { kind: 'stream'; response: Response }
    | { kind: 'unavailable'; reason: 'identity' | 'not-running' }

// Reattach to one live run. This does not call the chat endpoint and does not start a turn.
export async function resumeDesktopChat(runtime: DesktopRuntime, sessionId: string, runId: string): Promise<DesktopResumeResult> {
    if (!RUN_ID.test(runId)) return { kind: 'unavailable', reason: 'identity' }
    const { engineAgentId, engineSessionId, runs } = await ownedRuns(runtime, sessionId)
    const decision = desktopResumeDecision(runs, engineAgentId, engineSessionId, runId)
    if (decision.action === 'unavailable') return { kind: 'unavailable', reason: decision.reason }
    let engineResponse: Response
    try {
        engineResponse = await reconnectRun(engineOf(runtime), engineAgentId, decision.runId)
    } catch {
        throw new DesktopHttpError(503, 'This reply cannot be resumed. Nothing was sent again.')
    }
    if (engineResponse.status === 204 || !engineResponse.ok || !engineResponse.body) return { kind: 'unavailable', reason: 'not-running' }
    const headers = new Headers({
        'content-type': engineResponse.headers.get('content-type') ?? 'text/event-stream',
        'x-vercel-ai-ui-message-stream': engineResponse.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1',
        'x-rerun-resume': 'streaming',
        'cache-control': 'no-store',
    })
    return { kind: 'stream', response: new Response(engineResponse.body.pipeThrough(new TransformStream()), { status: 200, headers }) }
}
