import type { SubRunCall, SubRunTask } from '@rerun/contracts'
import type { DesktopDelegationTask } from '../../../../../packages/contracts/src/desktop-delegation'

/** Display shape for the original sub-run helpers. Absent timing stays absent. */
export function delegationTaskToSubRun(task: DesktopDelegationTask): SubRunTask {
    const calls: SubRunCall[] = task.calls.map(call => {
        const view: SubRunCall = { tool: call.tool, summary: call.summary }
        if (call.failed !== undefined) view.failed = call.failed
        if (call.durationMs !== undefined) view.durationMs = call.durationMs
        if (call.elapsedMs !== undefined) view.elapsedMs = call.elapsedMs
        return view
    })
    const view: SubRunTask = {
        id: task.taskId,
        title: task.title,
        status: task.status,
        steps: task.steps,
        toolCalls: task.toolCalls,
        failures: task.failures,
        calls,
        preview: task.preview,
    }
    if (task.activity !== undefined) view.activity = task.activity
    if (task.idleMs !== undefined) view.idleMs = task.idleMs
    if (task.startedAt !== undefined) view.startedAt = task.startedAt
    if (task.finishedAt !== undefined) view.finishedAt = task.finishedAt
    if (task.error !== undefined) view.error = task.error
    return view
}
