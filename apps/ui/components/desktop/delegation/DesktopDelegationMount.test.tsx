// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DELEGATION_LIST_UNREADABLE, DELEGATION_STOP_UNFINISHED, DesktopDelegationReadError, type DesktopDelegationClient } from '@/lib/desktop/delegation-client'
import type { DesktopDelegationSnapshot, DesktopDelegationTask } from '@rerun/contracts'
import { DesktopDelegationMount } from './DesktopDelegationMount'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const delegationId = '11111111-1111-4111-8111-111111111111'
const taskId = '22222222-2222-4222-8222-222222222222'
const revision = '44444444-4444-4444-8444-444444444444'
const roots: Root[] = []

function task(over: Partial<DesktopDelegationTask> = {}): DesktopDelegationTask {
    return {
        taskId, title: 'Write the notes', status: 'done', steps: 1, toolCalls: 0, failures: 0, preview: 'Finished the notes.',
        calls: [], cleanup: 'complete', ...over,
    }
}

function snapshot(over: Partial<DesktopDelegationSnapshot> = {}): DesktopDelegationSnapshot {
    return {
        delegationId, revision, parentAgentId: 'agent-a', parentSessionId: 'session-a', parentRunId: 'run-a',
        toolCallId: 'tool-a', tasks: [task(), task({ taskId: '33333333-3333-4333-8333-333333333333', title: 'Check the sources' })], ...over,
    }
}

function client(list: DesktopDelegationClient['list'], stop: DesktopDelegationClient['stop'] = vi.fn(async () => snapshot())): DesktopDelegationClient {
    return { list, stop, dispose: vi.fn() }
}

async function render(node: ReactNode) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(node) })
    return root
}

async function openDetails() {
    const button = document.querySelector<HTMLButtonElement>('[data-delegation-id] button[aria-expanded]')
    expect(button).not.toBeNull()
    if (button!.getAttribute('aria-expanded') === 'false') await act(async () => { button!.click() })
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => { root.unmount() })
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
})

test('renders a saved delegation without a live clock and stops polling', async () => {
    const list = vi.fn(async () => [snapshot()])
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(list)} fallback={<p>Tool step</p>} />)
    expect(document.body.textContent).toContain('2 tasks done')
    await openDetails()
    expect(document.body.textContent).toContain('Finished the notes.')
    expect(document.body.textContent).not.toContain('Tool step')
    expect(document.querySelector('.font-mono')).toBeNull()
    const calls = list.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(6_000) })
    expect(list.mock.calls.length).toBe(calls)
})

test('polls while a task is still running', async () => {
    const list = vi.fn(async () => [snapshot({ tasks: [task({ status: 'running', preview: '', cleanup: 'pending', calls: [{ tool: 'web_search', summary: 'notes' }] })] })])
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" view="live" client={client(list)} />)
    expect(document.body.textContent).toContain('Delegating · 1 task')
    const calls = list.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    await act(async () => { vi.advanceTimersByTime(3_000) })
    expect(list.mock.calls.length).toBeGreaterThan(calls)
})

test('applies a successful Stop and leaves a failed Stop retryable', async () => {
    const running = snapshot({ tasks: [task({ status: 'running', preview: '', cleanup: 'pending' })] })
    const stopped = snapshot({
        revision: '55555555-5555-4555-8555-555555555555',
        tasks: [task({ status: 'stopped', cleanup: 'complete' })],
    })
    let current = running
    const list = vi.fn(async () => [current])
    let failed = false
    const stop = vi.fn<DesktopDelegationClient['stop']>(async () => {
        if (!failed) {
            failed = true
            throw new Error('Delegation unavailable or changed. Refresh and retry Stop.')
        }
        current = stopped
        return stopped
    })
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(list, stop)} />)
    const button = () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop this task"]')
    expect(button()).not.toBeNull()
    await act(async () => { button()!.click() })
    expect(button()?.hasAttribute('disabled')).toBe(false)
    expect(document.body.textContent).toContain('Delegation unavailable or changed. Refresh and retry Stop.')
    expect(document.body.textContent).not.toContain('Stopped, partial work kept')
    await act(async () => { button()!.click() })
    expect(button()).toBeNull()
    await openDetails()
    expect(document.body.textContent).toContain('Stopped, partial work kept')
    expect(stop.mock.calls.map(call => call[1])).toEqual([
        { delegationId, taskId, expectedRevision: revision },
        { delegationId, taskId, expectedRevision: revision },
    ])
})

test('keeps the tool fallback when the read fails and does not invent tasks', async () => {
    const list = vi.fn(async () => { throw new Error('Delegated tasks could not be loaded.') })
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(list)} fallback={<p>Tool step</p>} />)
    expect(document.body.textContent).toContain('Delegated tasks could not be loaded.')
    expect(document.body.textContent).toContain('Tool step')
    expect(document.body.textContent).not.toContain('Delegating')
    expect(document.querySelector('[data-state="unavailable"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Stop this task"]')).toBeNull()
})

test('separates loading, empty, and malformed reads', async () => {
    let release: (rows: ReturnType<typeof snapshot>[]) => void = () => {}
    const pending = vi.fn(() => new Promise<ReturnType<typeof snapshot>[]>(resolve => { release = resolve }))
    const root = await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(pending)} fallback={<p>Tool step</p>} />)
    expect(document.querySelector('[data-state="loading"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Tool step')
    expect(document.body.textContent).not.toContain('tasks done')
    await act(async () => { release([]) })
    expect(document.querySelector('[data-state="empty"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('tasks done')
    const stop = vi.fn()
    await act(async () => {
        root.render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(vi.fn(async () => { throw new DesktopDelegationReadError('malformed', DELEGATION_LIST_UNREADABLE) }), stop)} fallback={<p>Tool step</p>} />)
    })
    expect(document.querySelector('[data-state="malformed"]')).not.toBeNull()
    expect(document.body.textContent).toContain(DELEGATION_LIST_UNREADABLE)
    expect(document.body.textContent).not.toContain('tasks done')
    expect(stop).not.toHaveBeenCalled()
})

test('pairs the block to the parent tool call and ignores the other row', async () => {
    const otherId = '66666666-6666-4666-8666-666666666666'
    const list = vi.fn(async () => [
        snapshot({ tasks: [task({ title: 'This call' })] }),
        snapshot({ delegationId: otherId, toolCallId: 'tool-b', parentRunId: 'run-b', tasks: [task({ title: 'Other call' })] }),
    ])
    await render(<DesktopDelegationMount sessionId="session-a" agentId="agent-a" toolCallId="tool-a" client={client(list)} />)
    await openDetails()
    expect(document.body.textContent).toContain('This call')
    expect(document.body.textContent).not.toContain('Other call')
    expect(document.querySelector('[data-tool-call-id="tool-a"]')).not.toBeNull()
    expect(document.querySelector('[data-parent-run-id="run-a"]')).not.toBeNull()
    expect(document.querySelector('[data-parent-agent-id="agent-a"]')).not.toBeNull()
    expect(document.querySelector('[data-tool-call-id="tool-b"]')).toBeNull()
})

test('history does not poll or start a clock, and a parent outcome does not post Stop', async () => {
    const running = snapshot({ tasks: [task({ status: 'running', preview: '', cleanup: 'pending' })] })
    const stopped = snapshot({ tasks: [task({ status: 'stopped', cleanup: 'complete', preview: 'partial kept' })] })
    const list = vi.fn(async () => [running])
    const stop = vi.fn()
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" view="history" parentSnapshots={[stopped]} client={client(list, stop)} />)
    await openDetails()
    expect(document.body.textContent).toContain('Stopped, partial work kept')
    expect(document.querySelector('.font-mono')).toBeNull()
    expect(stop).not.toHaveBeenCalled()
    const calls = list.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(6_000) })
    expect(list.mock.calls.length).toBe(calls)
    expect(stop).not.toHaveBeenCalled()
})

test('a transcript keeps the saved result when the live list is empty', async () => {
    const list = vi.fn(async () => [])
    const stop = vi.fn()
    await render(
        <DesktopDelegationMount
            sessionId="session-a"
            toolCallId="tool-a"
            view="history"
            projection={{ delegations: [snapshot()] }}
            client={client(list, stop)}
            fallback={<p>Tool step</p>}
        />,
    )
    await openDetails()
    expect(document.body.textContent).toContain('Finished the notes.')
    expect(document.body.textContent).not.toContain('Tool step')
    expect(stop).not.toHaveBeenCalled()
    expect(document.querySelector('[data-view="history"]')).not.toBeNull()
})

test('a malformed transcript is not an empty success', async () => {
    const stop = vi.fn()
    await render(
        <DesktopDelegationMount
            sessionId="session-a"
            toolCallId="tool-a"
            view="history"
            projection={{ delegations: [{ bad: true }] }}
            client={client(vi.fn(async () => []), stop)}
            fallback={<p>Tool step</p>}
        />,
    )
    expect(document.querySelector('[data-state="malformed"]')).not.toBeNull()
    expect(document.body.textContent).toContain(DELEGATION_LIST_UNREADABLE)
    expect(document.body.textContent).not.toContain('tasks done')
    expect(stop).not.toHaveBeenCalled()
})

test('a late Stop cannot mark a different tool call', async () => {
    const running = snapshot({ tasks: [task({ status: 'running', preview: '', cleanup: 'pending' })] })
    const stopped = snapshot({ revision: '55555555-5555-4555-8555-555555555555', tasks: [task({ status: 'stopped', cleanup: 'complete' })] })
    let release: (value: typeof stopped) => void = () => {}
    const list = vi.fn(async () => [running])
    const stop = vi.fn(() => new Promise<typeof stopped>(resolve => { release = resolve }))
    const api = client(list, stop)
    const root = await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={api} fallback={<p>Other tool</p>} />)
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Stop this task"]')
    await act(async () => { button!.click() })
    await act(async () => {
        root.render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-b" client={api} fallback={<p>Other tool</p>} />)
    })
    await act(async () => { release(stopped) })
    expect(document.body.textContent).not.toContain('Stopped, partial work kept')
    expect(document.body.textContent).toContain('Other tool')
})

test('a Stop for another owner refreshes and does not mark the task', async () => {
    const running = snapshot({ tasks: [task({ status: 'running', preview: '', cleanup: 'pending' })] })
    const foreign = snapshot({ parentAgentId: 'agent-b', tasks: [task({ status: 'stopped', cleanup: 'complete' })] })
    const list = vi.fn(async () => [running])
    const stop = vi.fn(async () => foreign)
    await render(<DesktopDelegationMount sessionId="session-a" agentId="agent-a" toolCallId="tool-a" client={client(list, stop)} />)
    const button = () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop this task"]')
    const reads = list.mock.calls.length
    await act(async () => { button()!.click() })
    expect(document.body.textContent).not.toContain('Stopped, partial work kept')
    expect(button()?.hasAttribute('disabled')).toBe(false)
    expect(list.mock.calls.length).toBeGreaterThan(reads)
})

test('an unfinished Stop stays on the same task and can be retried', async () => {
    const running = snapshot({ tasks: [task({ status: 'running', preview: '', cleanup: 'pending' })] })
    const list = vi.fn(async () => [running])
    const stop = vi.fn<DesktopDelegationClient['stop']>(async () => { throw new DesktopDelegationReadError('unfinished', DELEGATION_STOP_UNFINISHED) })
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(list, stop)} />)
    const button = () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop this task"]')
    await act(async () => { button()!.click() })
    expect(button()?.hasAttribute('disabled')).toBe(false)
    expect(document.body.textContent).toContain(DELEGATION_STOP_UNFINISHED)
    expect(document.body.textContent).not.toContain('Stopped, partial work kept')
    await act(async () => { button()!.click() })
    expect(stop).toHaveBeenCalledTimes(2)
    expect(stop.mock.calls.map(call => call[1])).toEqual([
        { delegationId, taskId, expectedRevision: revision },
        { delegationId, taskId, expectedRevision: revision },
    ])
})

test('unmount aborts the read and does not post Stop', async () => {
    let signal: AbortSignal | undefined
    const list = vi.fn((_sessionId: string, next?: AbortSignal) => {
        signal = next
        return new Promise<ReturnType<typeof snapshot>[]>(() => {})
    })
    const stop = vi.fn()
    const root = await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(list, stop)} />)
    expect(signal?.aborted).toBe(false)
    await act(async () => { root.unmount() })
    expect(signal?.aborted).toBe(true)
    expect(stop).not.toHaveBeenCalled()
})

test('opening the settled row does not post Stop', async () => {
    const stop = vi.fn()
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" view="history" client={client(vi.fn(async () => [snapshot()]), stop)} />)
    const trigger = document.querySelector<HTMLButtonElement>('[data-delegation-id] button[aria-expanded]')
    await act(async () => { trigger!.click() })
    await act(async () => { trigger!.click() })
    expect(stop).not.toHaveBeenCalled()
})

test('Stop retries keep the selected task token when a sibling refresh changes the snapshot revision', async () => {
    const stopRevision = '77777777-7777-4777-8777-777777777777'
    let current = snapshot({ tasks: [task({ status: 'running', cleanup: 'pending', stopRevision })] })
    const list = vi.fn(async () => [current])
    const stop = vi.fn<DesktopDelegationClient['stop']>(async () => {
        if (stop.mock.calls.length === 1) {
            current = { ...current, revision: '88888888-8888-4888-8888-888888888888' }
            throw new Error(DELEGATION_STOP_UNFINISHED)
        }
        current = { ...current, tasks: [task({ status: 'stopped', cleanup: 'complete', stopRevision })] }
        return current
    })
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(list, stop)} />)
    await openDetails()
    const stopButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop this task"]')!
    expect(stopButton()).not.toBeNull()
    await act(async () => { stopButton().click() })
    expect(document.body.textContent).toContain(DELEGATION_STOP_UNFINISHED)
    await act(async () => { stopButton().click() })
    expect(stop.mock.calls.map(call => call[1])).toEqual([
        { delegationId, taskId, expectedRevision: stopRevision },
        { delegationId, taskId, expectedRevision: stopRevision },
    ])
})
