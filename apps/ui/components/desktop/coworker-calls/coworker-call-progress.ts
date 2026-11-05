import type { ToolState } from '@/components/chat/ToolCallBlock'
import type { SubRunProgress, SubRunStatus } from '@/lib/chat/sub-run-progress'
import type { DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'

const TASK_STATUS: Record<DesktopCoworkerCallSnapshot['status'], SubRunStatus> = {
    queued: 'queued',
    running: 'running',
    dispatched: 'dispatched',
    'waiting-human': 'running',
    completed: 'done',
    error: 'error',
    cancelled: 'error',
    interrupted: 'error',
}

const taskError = (call: DesktopCoworkerCallSnapshot): string | undefined => {
    if (call.status === 'cancelled') return 'Call cancelled.'
    if (call.status === 'interrupted') return 'Call interrupted.'
    if (call.status === 'error') return call.progress.preview || 'Coworker call failed.'
    return undefined
}

export const isDesktopCoworkerCallLive = (call: DesktopCoworkerCallSnapshot) => call.status === 'queued' || call.status === 'running' || call.status === 'waiting-human'

export const desktopCoworkerCallState = (call: DesktopCoworkerCallSnapshot): ToolState =>
    isDesktopCoworkerCallLive(call) ? 'input-available' : call.status === 'error' || call.status === 'cancelled' || call.status === 'interrupted' ? 'output-error' : 'output-available'

export function desktopCoworkerCallProgress(call: DesktopCoworkerCallSnapshot): SubRunProgress {
    return {
        kind: 'call-agent',
        tasks: [{
            id: call.callId,
            title: call.targetName,
            status: TASK_STATUS[call.status],
            steps: call.progress.steps,
            toolCalls: call.progress.toolCalls,
            failures: call.progress.failures,
            preview: call.progress.preview,
            error: taskError(call),
            calls: call.progress.calls.map(progressCall => ({
                tool: progressCall.tool,
                summary: progressCall.status,
                failed: ['failed', 'error', 'cancelled', 'interrupted'].includes(progressCall.status) || undefined,
            })),
        }],
    }
}
