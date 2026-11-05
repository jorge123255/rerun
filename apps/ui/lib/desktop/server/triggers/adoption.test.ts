import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/engine/client', () => ({
    getSession: vi.fn(async () => ({ id: 'eng-sess', agentId: 'eng-1', source: 'trigger', title: 'Hook', createdAt: '2026-01-01T00:00:00.000Z' })),
    getRun: vi.fn(async () => ({ id: 'run-1', agentId: 'eng-1', sessionId: 'eng-sess', triggerSource: 'trigger', triggerSlug: 'hook', status: 'running' })),
    listSessions: vi.fn(async () => []),
}))

vi.mock('../store', () => ({
    findDesktopAgent: vi.fn(async () => ({ id: 'local-1', engineAgentId: 'eng-1' })),
    sessionOf: (row: any) => ({ id: String(row.id), title: String(row.title), agentId: String(row.agent_id), engineSessionId: String(row.engine_session_id) }),
}))

vi.mock('../roster-writes', () => ({
    withRosterWrite: async (fn: any) => fn(),
}))

describe('adoptDesktopTriggerSession', () => {
    it('adopts once and rejects wrong source/owner', async () => {
        const { adoptDesktopTriggerSession } = await import('./adoption')
        const { getSession } = await import('@/lib/engine/client')
        const calls: any[] = []
        const db = {
            batch: async (statements: any[]) => {
                calls.push(statements)
                return [{}, { rows: [{ id: 'local-sess', title: 'Hook', agent_id: 'local-1', engine_session_id: 'eng-sess' }] }]
            },
            execute: async () => ({ rows: [] }),
        } as any
        const first = await adoptDesktopTriggerSession(db, {} as any, {
            agentId: 'local-1', engineAgentId: 'eng-1', engineSessionId: 'eng-sess', runId: 'run-1',
        })
        expect(first.tabUid).toBe('trigger:local-sess')
        expect(first.sessionId).toBe('local-sess')

        ;(getSession as any).mockResolvedValueOnce({ id: 'eng-sess', agentId: 'eng-1', source: 'schedule', title: 'Nope', createdAt: '2026-01-01T00:00:00.000Z' })
        await expect(adoptDesktopTriggerSession(db, {} as any, {
            agentId: 'local-1', engineAgentId: 'eng-1', engineSessionId: 'eng-sess',
        })).rejects.toMatchObject({ status: 409 })
    })
})
