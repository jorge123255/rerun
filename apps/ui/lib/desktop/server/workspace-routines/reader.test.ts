import { expect, test, vi } from 'vitest'
import { createDesktopWorkspaceRoutinesReader, type DesktopWorkspaceRoutinesAuthority } from './reader'
import type { DesktopScheduleRecord } from '@rerun/contracts'

const schedule = (agentId: string, slug: string, patch: Partial<DesktopScheduleRecord> = {}) => ({
    agentId, slug, name: slug, description: '', body: 'Do work', cron: '0 8 * * *', runAt: null, timezone: 'UTC', enabled: true, revision: `${agentId}-${slug}-v1`, lastRunAt: null, ...patch,
})
const run = (agentId: string, slug: string, patch: Record<string, unknown> = {}) => ({ id: `${agentId}-${slug}-run`, agentId, sessionId: `${agentId}-${slug}-session`, triggerSource: 'schedule', triggerSlug: slug, status: 'running', startedAt: '2026-11-05T08:00:00.000Z', ...patch })
const owners = [
    { agentId: 'agent-a', engineAgentId: 'engine-a', name: 'Ada', enabled: true, setupPending: false, scheduleGranted: true },
    { agentId: 'agent-b', engineAgentId: 'engine-b', name: 'Bea', enabled: true, setupPending: true, scheduleGranted: true },
]

test('aggregates exact owners/revisions, running/last results, setup state and ordering without granting mutations', async () => {
    const authority: DesktopWorkspaceRoutinesAuthority = {
        listOwners: vi.fn(async () => owners),
        listSchedules: vi.fn(async (owner: { agentId: string }) => owner.agentId === 'agent-a' ? [schedule('agent-a', 'daily')] : [schedule('agent-b', 'weekly', { enabled: false })]),
        listLatestRuns: vi.fn(async (owner: { agentId: string }) => owner.agentId === 'agent-a' ? [
            run('agent-b', 'daily', { startedAt: '2026-11-07T08:00:00.000Z' }),
            run('agent-a', 'daily', { id: 'latest', sessionId: 'latest-session', startedAt: '2026-11-06T08:00:00.000Z', status: 'done' }),
            run('agent-a', 'daily'),
        ] : []),
        adopt: vi.fn(async (_owner, run) => ({ agentId: run.agentId, sessionId: run.sessionId, engineSessionId: run.sessionId, tabUid: `schedule:${run.sessionId}`, title: 'Daily result', runId: run.id })),
        canRename: vi.fn(async () => true),
    }
    const reader = createDesktopWorkspaceRoutinesReader(authority)
    const result = await reader.list()
    expect(result.canRename).toBe(true)
    expect(result.routines).toHaveLength(2)
    const daily = result.routines.find(routine => routine.slug === 'daily')!
    expect(daily).toMatchObject({ agentId: 'agent-a', revision: 'agent-a-daily-v1', runningSince: '2026-11-05T08:00:00.000Z' })
    expect(daily.lastResult).toMatchObject({ runId: 'latest', chat: { sessionId: 'latest-session', runId: 'latest' } })
    expect(result.routines.find(routine => routine.slug === 'weekly')).toMatchObject({ agentId: 'agent-b', setupPending: true, nextRunAt: null })
    expect(authority.adopt).toHaveBeenCalledTimes(1)
})

test('a failed owner reports an unavailable snapshot instead of silently hiding routines', async () => {
    const authority: DesktopWorkspaceRoutinesAuthority = {
        listOwners: vi.fn(async () => owners),
        listSchedules: vi.fn(async (owner: { agentId: string }) => { if (owner.agentId === 'agent-a') throw new Error('offline'); return [schedule('agent-b', 'weekly', { lastRunAt: null })] }),
        listLatestRuns: vi.fn(async () => []),
        adopt: vi.fn(),
        canRename: vi.fn(async () => false),
    }
    await expect(createDesktopWorkspaceRoutinesReader(authority).list()).rejects.toThrow('Some coworker routines could not be read')
    expect(authority.adopt).not.toHaveBeenCalled()
})

test('projects only the next future routine for each eligible owner without adopting chat results', async () => {
    const now = new Date('2026-11-13T13:00:00Z')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const [ada, bea] = owners
    const ownerList = [ada, bea,
        { ...ada, agentId: 'revoked', scheduleGranted: false },
        { ...ada, agentId: 'disabled', enabled: false },
        { ...ada, agentId: 'second' },
    ]
    const oneShot = (agentId: string, slug: string, runAt: string, patch: Partial<DesktopScheduleRecord> = {}) =>
        schedule(agentId, slug, { cron: null, runAt, ...patch })
    const authority: DesktopWorkspaceRoutinesAuthority = {
        listOwners: vi.fn(async () => ownerList),
        listSchedules: vi.fn(async owner => owner.agentId === 'agent-a' ? [
            oneShot('agent-a', 'past', '2026-11-13T12:30:00Z'),
            oneShot('agent-a', 'paused', '2026-11-13T13:30:00Z', { enabled: false }),
            oneShot('agent-a', 'fired', '2026-11-13T13:45:00Z', { lastRunAt: '2026-11-13T12:45:00Z' }),
            oneShot('agent-a', 'invalid', 'invalid'),
            oneShot('agent-a', 'nearest', '2026-11-13T14:00:00Z'),
            oneShot('agent-a', 'later', '2026-11-13T15:00:00Z'),
        ] : [schedule(owner.agentId, 'recurring', { cron: '30 8 * * *', timezone: 'America/Chicago' })]),
        listLatestRuns: vi.fn(),
        adopt: vi.fn(),
        canRename: vi.fn(),
    }
    try {
        await expect(createDesktopWorkspaceRoutinesReader(authority).upcoming()).resolves.toEqual([
            { agentId: 'agent-a', name: 'nearest', at: Date.parse('2026-11-13T14:00:00Z') },
            { agentId: 'second', name: 'recurring', at: Date.parse('2026-11-13T14:30:00Z') },
        ])
        expect(vi.mocked(authority.listSchedules).mock.calls.map(([owner]) => owner.agentId)).toEqual(['agent-a', 'second'])
        expect(authority.listLatestRuns).not.toHaveBeenCalled()
        expect(authority.adopt).not.toHaveBeenCalled()
        expect(authority.canRename).not.toHaveBeenCalled()
    } finally {
        clock.mockRestore()
    }
})
