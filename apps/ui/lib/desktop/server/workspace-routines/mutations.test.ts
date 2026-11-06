import { expect, test, vi } from 'vitest'
import { desktopWorkspaceRoutineFingerprint, createDesktopWorkspaceRoutinesMutator, type DesktopWorkspaceRoutinesMutationAuthority } from './mutations'
import type { DesktopScheduleRecord } from '../../../../../../packages/contracts/src/desktop-workspace-routines'

const current: DesktopScheduleRecord = { agentId: 'agent-a', slug: 'daily', name: 'Daily', description: '', body: 'Work', cron: '0 8 * * *', runAt: null, timezone: 'UTC', enabled: true, revision: 'v1', lastRunAt: null }
const chat = { agentId: 'agent-a', sessionId: 'chat-a', engineSessionId: 'engine-chat-a', tabUid: 'schedule:chat-a', title: 'Daily', runId: 'run-a' }
const routine = { ...current, frequency: 'Every day at 8:00 AM', nextRunAt: null, runningSince: null, setupPending: false }

function authority(patch: Partial<DesktopWorkspaceRoutinesMutationAuthority> = {}): DesktopWorkspaceRoutinesMutationAuthority {
    return {
        current: vi.fn(async () => current),
        authorize: vi.fn(async () => {}),
        receipt: vi.fn(async () => null),
        mutate: vi.fn(async input => ({ routine: input.action === 'rename' ? { ...routine, name: input.name } : routine, chat })),
        ...patch,
    }
}

test('deleted or same-name replacement revision refuses before mutation', async () => {
    const a = authority()
    const mutator = createDesktopWorkspaceRoutinesMutator(a)
    await expect(mutator.rename({ action: 'rename', agentId: 'agent-a', slug: 'daily', expectedRevision: 'replacement', requestId: '00000000-0000-4000-8000-000000000001', name: 'Renamed' })).rejects.toMatchObject({ status: 409 })
    expect(a.mutate).not.toHaveBeenCalled()
})

test('a duplicate/lost acknowledgement returns the existing occurrence without another effect', async () => {
    const a = authority({ receipt: vi.fn(async input => ({ fingerprint: desktopWorkspaceRoutineFingerprint(input), result: { routine, chat } })) })
    const result = await createDesktopWorkspaceRoutinesMutator(a).run({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000001' })
    expect(result.chat).toEqual(chat)
    expect(a.current).not.toHaveBeenCalled()
    expect(a.mutate).not.toHaveBeenCalled()
})

test('rename, pause/resume and Run now bind exact owner/schedule/revision and current authority', async () => {
    const a = authority()
    const mutator = createDesktopWorkspaceRoutinesMutator(a)
    await mutator.rename({ action: 'rename', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000002', name: 'Renamed' })
    await mutator.toggle({ action: 'toggle', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000003', enabled: false })
    const result = await mutator.run({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000004' })
    expect(a.authorize).toHaveBeenCalledTimes(3)
    expect(a.mutate).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'rename', name: 'Renamed' }), undefined)
    expect(a.mutate).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'toggle', enabled: false }), undefined)
    expect(result.chat).toEqual(chat)
})

test('disabled coworker/setup/model refusal does not fabricate a run or result chat', async () => {
    const a = authority({ authorize: vi.fn(async () => { throw Object.assign(new Error('Enable this coworker to use routines'), { status: 403 }) }) })
    await expect(createDesktopWorkspaceRoutinesMutator(a).run({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000004' })).rejects.toMatchObject({ status: 403 })
    expect(a.mutate).not.toHaveBeenCalled()
})


test('a request ID cannot replay another owner or payload', async () => {
    const a = authority({ receipt: vi.fn(async () => ({ fingerprint: 'wrong-owner', result: { routine, chat } })) })
    await expect(createDesktopWorkspaceRoutinesMutator(a).run({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000010' })).rejects.toMatchObject({ status: 409 })
    expect(a.mutate).not.toHaveBeenCalled()
})

test('an exact reserved attempt reconciles through its engine receipt instead of failing its now-landed old revision', async () => {
    const input = { action: 'toggle' as const, agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000011', enabled: false }
    const a = authority({ receipt: vi.fn(async value => ({ fingerprint: desktopWorkspaceRoutineFingerprint(value), result: null, reserved: true })), current: vi.fn(async () => ({ ...current, revision: 'landed-v2' })) })
    await createDesktopWorkspaceRoutinesMutator(a).toggle(input)
    expect(a.current).not.toHaveBeenCalled()
    expect(a.mutate).toHaveBeenCalledWith(input, undefined)
})
