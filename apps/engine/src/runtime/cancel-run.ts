import { cancelRun, getRun } from '../db/repos/runs.js'
import type { RunRow } from '../db/schema.js'
import { desktopApp } from '../desktop/policy.js'
import { abortRun, waitForRunCancellation } from './run-control.js'
import { emitRunTerminal, triggerFromRun } from './run-events.js'

export async function cancelOwnedRun(run: RunRow) {
    const { id: runId, agentId, sessionId } = run
    const aborted = abortRun(runId)
    if (desktopApp() && !await waitForRunCancellation(runId)) return { state: 'waiting' as const, aborted }
    const cancelled = run.status === 'running' && await cancelRun(agentId, runId)
    if (desktopApp() && !cancelled && (!aborted || (await getRun(agentId, runId))?.status !== 'cancelled')) {
        return { state: 'finished' as const, aborted }
    }
    // A live loop announces its own end. Only the Stop that settles an orphan announces it here.
    if (cancelled && !aborted) {
        await emitRunTerminal({
            agentId, sessionId, runId, trigger: triggerFromRun(run), kind: 'done', cancelled: true,
            provider: run.provider ?? undefined, model: run.model ?? undefined,
        })
    }
    return { state: 'cancelled' as const, aborted }
}
