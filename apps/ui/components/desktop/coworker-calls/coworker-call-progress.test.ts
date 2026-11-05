import { describe, expect, test } from 'vitest'
import type { DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'
import { desktopCoworkerCallProgress, desktopCoworkerCallState, isDesktopCoworkerCallLive } from './coworker-call-progress'

const call = (status: DesktopCoworkerCallSnapshot['status']): DesktopCoworkerCallSnapshot => ({
    callId: 'call-1', revision: 'revision-1', parentAgentId: 'parent-agent', parentSessionId: 'parent-chat', parentRunId: 'parent-run', toolCallId: 'tool-call-1',
    targetAgentId: 'target-agent', targetSessionId: 'target-chat', targetName: 'Ada', wait: true, status,
    createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:05:00.000Z',
    progress: { steps: 4, toolCalls: 3, failures: 1, preview: 'Found the answer. More detail follows.', calls: [{ tool: 'web_fetch', status: 'completed' }, { tool: 'shell_exec', status: 'failed' }] },
})

test.each([
    ['queued', 'queued', 'input-available', true],
    ['running', 'running', 'input-available', true],
    ['waiting-human', 'running', 'input-available', true],
    ['dispatched', 'dispatched', 'output-available', false],
    ['completed', 'done', 'output-available', false],
    ['error', 'error', 'output-error', false],
    ['cancelled', 'error', 'output-error', false],
    ['interrupted', 'error', 'output-error', false],
] as const)('maps %s to the original sub-run presentation', (status, taskStatus, toolState, live) => {
    const snapshot = call(status)
    expect(desktopCoworkerCallProgress(snapshot).tasks[0]).toMatchObject({ id: snapshot.callId, title: 'Ada', status: taskStatus, steps: 4, toolCalls: 3, failures: 1 })
    expect(desktopCoworkerCallState(snapshot)).toBe(toolState)
    expect(isDesktopCoworkerCallLive(snapshot)).toBe(live)
})

test('preserves progress without inventing durations or live timestamps after a restart', () => {
    const task = desktopCoworkerCallProgress(call('running')).tasks[0]
    expect(task.calls).toEqual([
        { tool: 'web_fetch', summary: 'completed' },
        { tool: 'shell_exec', summary: 'failed', failed: true },
    ])
    expect(task.startedAt).toBeUndefined()
    expect(task.finishedAt).toBeUndefined()
    expect(task.idleMs).toBeUndefined()
    expect(task.calls?.every(call => call.elapsedMs === undefined && call.durationMs === undefined)).toBe(true)
})

test('keeps cancelled and interrupted outcomes distinct from an answered call', () => {
    expect(desktopCoworkerCallProgress(call('cancelled')).tasks[0]?.error).toBe('Call cancelled.')
    expect(desktopCoworkerCallProgress(call('interrupted')).tasks[0]?.error).toBe('Call interrupted.')
    expect(desktopCoworkerCallProgress(call('completed')).tasks[0]?.error).toBeUndefined()
})
