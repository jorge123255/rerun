// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { SquareIcon } from '@/lib/icons'
import { DesktopDelegationTree } from './DesktopDelegationTree'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toolDisplay = () => ({ label: 'Search', iconProps: { icon: SquareIcon } })
const roots: Root[] = []

function task(over: Record<string, unknown> = {}) {
    return {
        taskId: '22222222-2222-4222-8222-222222222222', title: 'Write the notes', status: 'running', steps: 1,
        toolCalls: 1, failures: 0, preview: '', calls: [] as Array<Record<string, unknown>>, cleanup: 'pending', ...over,
    }
}

async function render(tasks: Array<Record<string, unknown>>, onStopTask?: (taskId: string) => Promise<void>) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<DesktopDelegationTree tasks={tasks as never} toolDisplay={toolDisplay} onStopTask={onStopTask} />) })
    return root
}

function stopButtons() {
    return [...document.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === 'Stop this task')
}

afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => { root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

test('keeps branch order and does not invent a duration or idle time', async () => {
    await render([
        task({ taskId: '33333333-3333-4333-8333-333333333333', title: 'Beta', status: 'done', preview: 'Beta finished. Tail.', cleanup: 'complete' }),
        task({ title: 'Alpha', status: 'error', error: 'Interrupted by restart; task was not replayed', cleanup: 'blocked' }),
    ])
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Beta')).toBeLessThan(text.indexOf('Alpha'))
    expect(text).toContain('Beta finished.')
    expect(text).toContain('Interrupted by restart; task was not replayed')
    expect(text).not.toContain('Idle')
    expect(document.querySelector('.font-mono')).toBeNull()
    expect(document.querySelector('.text-transparent')).toBeNull()
    expect(stopButtons()).toHaveLength(0)
})

test('shows a saved duration and the stopped outcome without the error string', async () => {
    await render([
        task({ status: 'stopped', startedAt: 1_000, finishedAt: 2_500, error: 'stopped along with the calling run or by the user', cleanup: 'complete' }),
    ])
    expect(document.body.textContent).toContain('Stopped, partial work kept')
    expect(document.body.textContent).toContain('1.5s')
    expect(document.body.textContent).not.toContain('stopped along with the calling run or by the user')
})

test('shows the last live calls and a skeleton when none is timed', async () => {
    await render([
        task({
            toolCalls: 5,
            calls: [
                { tool: 'web_search', summary: 'one' },
                { tool: 'web_search', summary: 'two' },
                { tool: 'web_search', summary: 'three' },
                { tool: 'web_search', summary: 'four' },
            ],
        }),
    ])
    const text = document.body.textContent ?? ''
    expect(text).toContain('+2 earlier')
    expect(text).not.toContain('Searching one')
    expect(text).toContain('Searching two')
    expect(text).toContain('Searching four')
    expect(document.querySelector('.text-transparent')).toBeNull()
    expect(document.querySelector('.border-dashed')).not.toBeNull()
})

test('shimmers only a call that still has elapsed time', async () => {
    await render([
        task({ calls: [{ tool: 'web_search', summary: 'now', elapsedMs: 20 }] }),
    ])
    expect(document.querySelector('.text-transparent')?.textContent).toContain('Searching now')
    expect(document.querySelector('.border-dashed')).toBeNull()
})

test('a failed Stop stays retryable and does not disable the other task', async () => {
    let rejectStop: (error: Error) => void = () => {}
    const onStop = vi.fn((_taskId: string) => new Promise<void>((_resolve, reject) => { rejectStop = reject }))
    await render([
        task(),
        task({ taskId: '33333333-3333-4333-8333-333333333333', title: 'Other', calls: [] }),
    ], onStop)
    const [first, second] = stopButtons()
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    await act(async () => { first!.click() })
    expect(first!.hasAttribute('disabled')).toBe(true)
    expect(second!.hasAttribute('disabled')).toBe(false)
    await act(async () => { rejectStop(new Error('Delegation unavailable or changed. Refresh and retry Stop.')) })
    expect(first!.hasAttribute('disabled')).toBe(false)
    expect(document.body.textContent).toContain('Delegation unavailable or changed. Refresh and retry Stop.')
    expect(document.body.textContent).not.toContain('Stopped, partial work kept')
    await act(async () => { first!.click() })
    expect(onStop).toHaveBeenCalledTimes(2)
    expect(onStop.mock.calls.map(call => call[0])).toEqual([
        '22222222-2222-4222-8222-222222222222',
        '22222222-2222-4222-8222-222222222222',
    ])
    await act(async () => { rejectStop(new Error('Delegation unavailable or changed. Refresh and retry Stop.')) })
})

test('keeps Stop available when cleanup is still unconfirmed', async () => {
    await render([
        task({ status: 'stopped', cleanup: 'blocked' }),
    ], async () => {})
    expect(stopButtons()).toHaveLength(1)
})

test('keeps request order and stable ids when tasks are mixed', async () => {
    const ids = [
        '33333333-3333-4333-8333-333333333333',
        '22222222-2222-4222-8222-222222222222',
        '44444444-4444-4444-8444-444444444444',
    ]
    await render([
        task({ taskId: ids[0], title: 'Done first', status: 'done', preview: 'Done first.', cleanup: 'complete' }),
        task({ taskId: ids[1], title: 'Still going', status: 'running', calls: [] }),
        task({ taskId: ids[2], title: 'Broke', status: 'error', error: 'Sub-coworker failed', cleanup: 'complete' }),
    ], async () => {})
    expect([...document.querySelectorAll('[data-task-id]')].map(node => node.getAttribute('data-task-id'))).toEqual(ids)
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Done first')).toBeLessThan(text.indexOf('Still going'))
    expect(text.indexOf('Still going')).toBeLessThan(text.indexOf('Broke'))
    expect(text).toContain('Sub-coworker failed')
    expect(stopButtons()).toHaveLength(1)
})

test('shows a recorded empty result and a missing outcome without a blank success', async () => {
    await render([
        task({ status: 'done', preview: '', result: '', cleanup: 'complete' }),
        task({ taskId: '33333333-3333-4333-8333-333333333333', title: 'Missing', status: 'done', preview: '', cleanup: 'complete' }),
        task({ taskId: '44444444-4444-4444-8444-444444444444', title: 'Waiting', status: 'queued', calls: [] }),
    ])
    expect(document.body.textContent).toContain('(the sub-coworker returned no text)')
    expect(document.querySelector('[data-outcome="reconcile"]')?.textContent).toContain('Delegated tasks could not be read.')
    expect(document.querySelector('[data-task-id="44444444-4444-4444-8444-444444444444"] .font-mono')).toBeNull()
})

test('opening and closing a settled detail does not stop the task', async () => {
    const onStop = vi.fn(async () => {})
    await render([
        task({ status: 'done', preview: 'Full notes stayed.', calls: [{ tool: 'web_search', summary: 'notes' }], cleanup: 'complete' }),
    ], onStop)
    const trigger = document.querySelector<HTMLButtonElement>('[data-task-id] button')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { trigger!.click() })
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.whitespace-pre-wrap')?.textContent).toContain('Full notes stayed.')
    await act(async () => { trigger!.click() })
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(onStop).not.toHaveBeenCalled()
    expect(stopButtons()).toHaveLength(0)
})

test('keeps a long title in a truncating row', async () => {
    const title = `Notes ${'x'.repeat(180)}`
    await render([task({ title, status: 'queued', calls: [] })])
    const label = document.querySelector('[data-task-id] .truncate')
    expect(label?.textContent).toBe(title)
    expect(label?.className).toContain('min-w-0')
})

test('a queued task can be stopped independently without inventing a start or a stopped acknowledgement', async () => {
    const queuedId = '66666666-6666-4666-8666-666666666666'
    const active = [2, 3, 4, 5].map(number => task({ taskId: `${number}2222222-2222-4222-8222-222222222222`, title: `Running ${number}` }))
    const queued = task({ taskId: queuedId, title: 'Waiting for a worker', status: 'queued', steps: 0, toolCalls: 0 })
    let rejectStop: (error: Error) => void = () => {}
    let resolveStop: () => void = () => {}
    const onStop = vi.fn((_taskId: string) => new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject }))
    const root = await render([...active, queued], onStop)
    const queuedBranch = document.querySelector(`[data-task-id="${queuedId}"]`)!
    const queuedStop = queuedBranch.querySelector<HTMLButtonElement>('[aria-label="Stop this task"]')!
    expect(stopButtons()).toHaveLength(5)
    expect(queuedBranch.querySelector('.font-mono')).toBeNull()

    await act(async () => { queuedStop.click() })
    expect(onStop).toHaveBeenCalledExactlyOnceWith(queuedId)
    expect(queuedStop.disabled).toBe(true)
    expect(stopButtons().filter(button => button !== queuedStop).every(button => !button.disabled)).toBe(true)
    expect(queuedBranch.textContent).not.toContain('Stopped, partial work kept')
    await act(async () => { rejectStop(new Error('Task changed. Refresh and retry Stop.')) })
    expect(queuedStop.disabled).toBe(false)
    expect(queuedBranch.textContent).toContain('Task changed. Refresh and retry Stop.')
    expect(queuedBranch.querySelector('.font-mono')).toBeNull()

    await act(async () => { queuedStop.click(); resolveStop() })
    expect(onStop.mock.calls.map(call => call[0])).toEqual([queuedId, queuedId])
    expect(queuedBranch.textContent).not.toContain('Stopped, partial work kept')
    await act(async () => {
        root.render(<DesktopDelegationTree tasks={[...active, { ...queued, status: 'stopped', cleanup: 'complete' }] as never} toolDisplay={toolDisplay} onStopTask={onStop} />)
    })
    expect(queuedBranch.textContent).toContain('Stopped, partial work kept')
    expect(queuedBranch.querySelector('[aria-label="Stop this task"]')).toBeNull()
    expect(queuedBranch.querySelector('.font-mono')).toBeNull()
    expect(stopButtons()).toHaveLength(4)
    expect(stopButtons().every(button => !button.disabled)).toBe(true)
})

test('hides Stop for done, error, and stopped tasks once cleanup is complete', async () => {
    await render([
        task({ taskId: '33333333-3333-4333-8333-333333333333', status: 'done', preview: 'Done.', cleanup: 'complete' }),
        task({ taskId: '44444444-4444-4444-8444-444444444444', status: 'error', error: 'Sub-coworker failed', cleanup: 'complete' }),
        task({ taskId: '55555555-5555-4555-8555-555555555555', status: 'stopped', cleanup: 'complete' }),
    ], async () => {})
    expect(stopButtons()).toHaveLength(0)
    expect(document.body.textContent).toContain('Sub-coworker failed')
    expect(document.body.textContent).toContain('Stopped, partial work kept')
})
