import { expect, test, vi } from 'vitest'
import { createDesktopWorkspaceRoutinesReader, type DesktopWorkspaceRoutinesAuthority } from './reader'
import type { DesktopScheduleRecord } from '@rerun/contracts'

const schedule = (agentId: string, slug: string, patch: Partial<DesktopScheduleRecord> = {}) => ({
    agentId, slug, name: slug, description: '', body: 'Do work', cron: '0 8 * * *', runAt: null, timezone: 'UTC', enabled: true, revision: `${agentId}-${slug}-v1`, lastRunAt: null, ...patch,
})
const run = (agentId: string, slug: string, patch: Record<string, unknown> = {}) => ({ id: `${agentId}-${slug}-run`, agentId, sessionId: `${agentId}-${slug}-session`, triggerSource: 'schedule', triggerSlug: slug, status: 'running', startedAt: '2026-11-05T08:00:00.000Z', ...patch })
const owners = [
    { agentId: 'agent-a', engineAgentId: 'engine-a', name: 'Ada', enabled: true, setupPending: false },
    { agentId: 'agent-b', engineAgentId: 'engine-b', name: 'Bea', enabled: true, setupPending: true },
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
