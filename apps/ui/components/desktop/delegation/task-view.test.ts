import { subRunHeadline } from '@rerun/contracts'
import { expect, test } from 'vitest'
import { DELEGATION_EMPTY_RESULT, DELEGATION_OUTCOME_UNREAD, delegationDetail, delegationOutcome, delegationTaskToSubRun } from './task-view'

const task = {
    taskId: '22222222-2222-4222-8222-222222222222',
    title: 'Write the notes',
    status: 'done' as const,
    steps: 2,
    toolCalls: 1,
    failures: 0,
    preview: 'Finished the notes. More detail.',
    calls: [{ tool: 'web_search', summary: 'notes' }],
    cleanup: 'complete' as const,
    result: 'Finished the notes. More detail that the preview does not replace.',
}

test('maps the public task id and leaves missing timing unset', () => {
    const view = delegationTaskToSubRun(task)
    expect(view.id).toBe(task.taskId)
    expect(view.preview).toBe(task.preview)
    expect(view).not.toHaveProperty('idleMs')
    expect(view).not.toHaveProperty('startedAt')
    expect(view).not.toHaveProperty('finishedAt')
    expect(view).not.toHaveProperty('activity')
    expect(view.calls?.[0]).not.toHaveProperty('elapsedMs')
    expect(JSON.stringify(view)).not.toContain(task.result.slice(task.preview.length))
})

test('keeps timestamps and elapsed calls the server actually saved', () => {
    const view = delegationTaskToSubRun({
        ...task,
        status: 'running',
        startedAt: 1_000,
        idleMs: 180_000,
        calls: [{ tool: 'web_search', summary: 'notes', elapsedMs: 25, failed: true }],
    })
    expect(view).toMatchObject({ startedAt: 1_000, idleMs: 180_000 })
    expect(view.calls?.[0]).toMatchObject({ elapsedMs: 25, failed: true })
    expect(view).not.toHaveProperty('finishedAt')
})

test('distinguishes an empty recorded result from a missing outcome', () => {
    expect(delegationOutcome({ ...task, preview: '', result: '' })).toEqual({ kind: 'empty-result', text: DELEGATION_EMPTY_RESULT })
    expect(delegationOutcome({ ...task, preview: '', result: undefined })).toEqual({ kind: 'reconcile', text: DELEGATION_OUTCOME_UNREAD })
    expect(delegationOutcome({ ...task, status: 'queued', preview: '', result: undefined, startedAt: undefined })).toBeNull()
    expect(delegationOutcome({ ...task, status: 'error', error: 'Interrupted by restart; task was not replayed', preview: '' })?.text).toBe('Interrupted by restart; task was not replayed')
    expect(delegationOutcome({ ...task, status: 'stopped', error: 'stopped along with the calling run or by the user', preview: 'partial' })?.text).toBe('Stopped, partial work kept')
    expect(delegationDetail({ ...task, preview: '', result: 'Kept after the workspace was removed.' })).toBe('Kept after the workspace was removed.')
    expect(delegationDetail({ ...task, preview: 'Visible tail', result: 'Full result' })).toBe('Visible tail')
})


test('reports intentional stops separately from failed delegated tasks', () => {
    const row = (status: 'done' | 'error' | 'stopped') => ({ title: status, status, steps: 0 })
    expect(subRunHeadline({ kind: 'delegate', tasks: [row('done'), row('done'), row('done'), row('stopped'), row('stopped')] }, false, 'delegate_tasks').label).toBe('3 done · 2 stopped')
    expect(subRunHeadline({ kind: 'delegate', tasks: [row('done'), row('error'), row('stopped')] }, false, 'delegate_tasks').label).toBe('1 done · 1 failed · 1 stopped')
})
