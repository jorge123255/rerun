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

test('hides Stop for queued, done, error, and stopped tasks once cleanup is complete', async () => {
    await render([
        task({ status: 'queued', calls: [] }),
        task({ taskId: '33333333-3333-4333-8333-333333333333', status: 'done', preview: 'Done.', cleanup: 'complete' }),
        task({ taskId: '44444444-4444-4444-8444-444444444444', status: 'error', error: 'Sub-coworker failed', cleanup: 'complete' }),
        task({ taskId: '55555555-5555-4555-8555-555555555555', status: 'stopped', cleanup: 'complete' }),
    ], async () => {})
    expect(stopButtons()).toHaveLength(0)
    expect(document.body.textContent).toContain('Sub-coworker failed')
    expect(document.body.textContent).toContain('Stopped, partial work kept')
})
