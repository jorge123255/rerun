// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopDelegationClient } from '@/lib/desktop/delegation-client'
import { DesktopDelegationMount } from './DesktopDelegationMount'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const delegationId = '11111111-1111-4111-8111-111111111111'
const taskId = '22222222-2222-4222-8222-222222222222'
const revision = '44444444-4444-4444-8444-444444444444'
const roots: Root[] = []

function task(over: Record<string, unknown> = {}) {
    return {
        taskId, title: 'Write the notes', status: 'done', steps: 1, toolCalls: 0, failures: 0, preview: 'Finished the notes.',
        calls: [], cleanup: 'complete', ...over,
    }
}

function snapshot(over: Record<string, unknown> = {}) {
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
    expect(document.body.textContent).toContain('Finished the notes.')
    expect(document.body.textContent).not.toContain('Tool step')
    expect(document.querySelector('.font-mono')).toBeNull()
    const calls = list.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(6_000) })
    expect(list.mock.calls.length).toBe(calls)
})

test('polls while a task is still running', async () => {
    const list = vi.fn(async () => [snapshot({ tasks: [task({ status: 'running', preview: '', cleanup: 'pending', calls: [{ tool: 'web_search', summary: 'notes' }] })] })])
    await render(<DesktopDelegationMount sessionId="session-a" toolCallId="tool-a" client={client(list)} />)
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
    const stop = vi.fn(async () => {
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
    expect(document.querySelector('button[aria-label="Stop this task"]')).toBeNull()
})
