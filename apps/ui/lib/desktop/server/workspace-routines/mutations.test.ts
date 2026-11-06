import { expect, test, vi } from 'vitest'
import { createDesktopWorkspaceRoutinesMutator, type DesktopWorkspaceRoutinesMutationAuthority } from './mutations'
import type { DesktopScheduleRecord } from '../../../../../../packages/contracts/src/desktop-workspace-routines'

const current: DesktopScheduleRecord = { agentId: 'agent-a', slug: 'daily', name: 'Daily', description: '', body: 'Work', cron: '0 8 * * *', runAt: null, timezone: 'UTC', enabled: true, revision: 'v1', lastRunAt: null }
const chat = { agentId: 'agent-a', sessionId: 'chat-a', engineSessionId: 'engine-chat-a', tabUid: 'schedule:chat-a', title: 'Daily', runId: 'run-a' }
const routine = { ...current, frequency: 'Every day at 8:00 AM', nextRunAt: null, runningSince: null, setupPending: false }

function authority(patch: Partial<DesktopWorkspaceRoutinesMutationAuthority> = {}): DesktopWorkspaceRoutinesMutationAuthority {
    return {
        current: vi.fn(async () => current),
        authorize: vi.fn(async () => {}),
        receipt: vi.fn(async () => null),
        mutate: vi.fn(async () => ({ routine, chat })),
        ...patch,
    }
}

test('deleted or same-name replacement revision refuses before mutation', async () => {
    const a = authority()
    const mutator = createDesktopWorkspaceRoutinesMutator(a)
    await expect(mutator.rename({ action: 'rename', agentId: 'agent-a', slug: 'daily', expectedRevision: 'replacement', requestId: 'request-1', name: 'Renamed' })).rejects.toMatchObject({ status: 409 })
    expect(a.mutate).not.toHaveBeenCalled()
})

test('a duplicate/lost acknowledgement returns the existing occurrence without another effect', async () => {
    const a = authority({ receipt: vi.fn(async () => ({ routine, chat })) })
    const result = await createDesktopWorkspaceRoutinesMutator(a).run({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: 'request-1' })
    expect(result.chat).toEqual(chat)
    expect(a.current).not.toHaveBeenCalled()
    expect(a.mutate).not.toHaveBeenCalled()
})

test('rename, pause/resume and Run now bind exact owner/schedule/revision and current authority', async () => {
    const a = authority()
    const mutator = createDesktopWorkspaceRoutinesMutator(a)
    await mutator.rename({ action: 'rename', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: 'request-rename', name: 'Renamed' })
    await mutator.toggle({ action: 'toggle', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: 'request-toggle', enabled: false })
    const result = await mutator.run({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: 'request-run' })
    expect(a.authorize).toHaveBeenCalledTimes(3)
    expect(a.mutate).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'rename', name: 'Renamed' }))
    expect(a.mutate).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'toggle', enabled: false }))
    expect(result.chat).toEqual(chat)
})

test('disabled coworker/setup/model refusal does not fabricate a run or result chat', async () => {
    const a = authority({ authorize: vi.fn(async () => { throw Object.assign(new Error('Enable this coworker to use routines'), { status: 403 }) } })
    await expect(createDesktopWorkspaceRoutinesMutator(a).run({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: 'request-run' })).rejects.toMatchObject({ status: 403 })
    expect(a.mutate).not.toHaveBeenCalled()
})
