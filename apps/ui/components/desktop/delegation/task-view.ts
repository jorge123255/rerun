import { subRunOutcome, type SubRunCall, type SubRunTask } from '@rerun/contracts'
import type { DesktopDelegationTask } from '@rerun/contracts'

/** D's ordered result when a done task saved an empty string. `orderedDelegationResult` in D's runtime. */
export const DELEGATION_EMPTY_RESULT = '(the sub-coworker returned no text)'
/** Settled task with neither preview nor result. Not a successful empty row. */
export const DELEGATION_OUTCOME_UNREAD = 'Delegated tasks could not be read.'

export type DesktopDelegationOutcome =
    | { kind: 'success' | 'empty-result' | 'error' | 'stopped' | 'reconcile'; text: string }
    | null

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

/**
 * Queued with no start stays unstarted (no line). Stopped keeps the original partial-work line.
 * A done task with an explicit empty result uses D's phrase. A done task missing both texts is a
 * reconciliation row, not a blank success.
 */
export function delegationOutcome(task: DesktopDelegationTask): DesktopDelegationOutcome {
    if (task.status === 'queued' || task.status === 'running' || task.status === 'dispatched') return null
    if (task.status === 'stopped') return { kind: 'stopped', text: 'Stopped, partial work kept' }
    if (task.status === 'error') return { kind: 'error', text: task.error || 'Failed' }
    const fromPreview = subRunOutcome(task.preview)
    if (fromPreview) return { kind: 'success', text: fromPreview }
    const recorded = task.result?.trim()
    if (recorded) return { kind: 'success', text: subRunOutcome(recorded) || recorded }
    if (task.result === '') return { kind: 'empty-result', text: DELEGATION_EMPTY_RESULT }
    return { kind: 'reconcile', text: DELEGATION_OUTCOME_UNREAD }
}

/** Preview, or the saved result when the preview was not stored. Never invented. */
export function delegationDetail(task: DesktopDelegationTask): string {
    if (task.preview.trim()) return task.preview
    return task.result?.trim() ? task.result : ''
}
