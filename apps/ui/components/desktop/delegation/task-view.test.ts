import { expect, test } from 'vitest'
import { delegationTaskToSubRun } from './task-view'

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
