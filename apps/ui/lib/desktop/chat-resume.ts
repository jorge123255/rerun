import type { Run } from '@rerun/contracts'

export type DesktopOwnedRun = Pick<Run, 'id' | 'agentId' | 'sessionId' | 'status' | 'error' | 'startedAt'>

export type DesktopRunRecovery = {
    activeRunId: string | null
    lastError: string | null
    failedRunId: string | null
    runVersion: string
}

// The newest run of this coworker and conversation is the only one that speaks.
// An older failure that a later run already answered is not replayed.
export function desktopRunRecovery(runs: readonly DesktopOwnedRun[], engineAgentId: string, engineSessionId: string): DesktopRunRecovery {
    const owned = runs
        .filter(run => run.agentId === engineAgentId && run.sessionId === engineSessionId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))
    const latest = owned[0]
    const running = owned.find(run => run.status === 'running')
    return {
        activeRunId: running?.id ?? null,
        lastError: latest?.status === 'error' ? latest.error?.trim() || null : null,
        failedRunId: latest?.status === 'error' ? latest.id : null,
        runVersion: JSON.stringify([latest?.id ?? null, latest?.status ?? null, running?.id ?? null]),
    }
}

export type DesktopResumeDecision =
    | { action: 'stream'; runId: string }
    | { action: 'unavailable'; reason: 'identity' | 'not-running' }

// Resume only the current running run of this exact coworker and conversation.
// Any other id is refused. This never describes a finished or foreign run as resumable.
export function desktopResumeDecision(runs: readonly DesktopOwnedRun[], engineAgentId: string, engineSessionId: string, requestedRunId: string): DesktopResumeDecision {
    const recovery = desktopRunRecovery(runs, engineAgentId, engineSessionId)
    if (!recovery.activeRunId || recovery.activeRunId !== requestedRunId) {
        const owned = runs.some(run => run.id === requestedRunId && run.agentId === engineAgentId && run.sessionId === engineSessionId)
        return { action: 'unavailable', reason: owned ? 'not-running' : 'identity' }
    }
    return { action: 'stream', runId: recovery.activeRunId }
}

type TranscriptMessage = { role: string; parts?: readonly { type?: string; text?: string }[] }

function assistantText(message: TranscriptMessage): string {
    return (message.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('')
}

// A failure that is already the saved assistant text is not announced a second time.
export function replayedRunFailure(messages: readonly TranscriptMessage[], lastError: string | null): string | null {
    const error = lastError?.trim() || null
    if (!error) return null
    const latestAssistant = [...messages].reverse().find(message => message.role === 'assistant')
    if (latestAssistant && assistantText(latestAssistant).trim() === error) return null
    return error
}
