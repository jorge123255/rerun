import { describe, expect, it, vi } from 'vitest'
import type { Client } from '@libsql/client'

vi.mock('@/lib/engine/client', () => ({
    getSession: vi.fn(async () => ({ id: 'eng-sess', agentId: 'eng-1', source: 'trigger', title: 'Hook', createdAt: '2026-01-01T00:00:00.000Z' })),
    getRun: vi.fn(async () => ({ id: 'run-1', agentId: 'eng-1', sessionId: 'eng-sess', triggerSource: 'trigger', triggerSlug: 'hook', status: 'running' })),
    listSessions: vi.fn(async () => []),
}))

vi.mock('../store', () => ({
    findDesktopAgent: vi.fn(async () => ({ id: 'local-1', engineAgentId: 'eng-1' })),
    sessionOf: (row: Record<string, unknown>) => ({ id: String(row.id), title: String(row.title), agentId: String(row.agent_id), engineSessionId: String(row.engine_session_id) }),
}))

vi.mock('../roster-writes', () => ({
    withRosterWrite: async <T>(fn: () => Promise<T>) => fn(),
}))

describe('adoptDesktopTriggerSession', () => {
    it('adopts once and rejects wrong source/owner', async () => {
        const { adoptDesktopTriggerSession } = await import('./adoption')
        const { getSession } = await import('@/lib/engine/client')
        const calls: unknown[][] = []
        const db = {
            batch: async (statements: unknown[]) => {
                calls.push(statements)
                return [{}, { rows: [{ id: 'local-sess', title: 'Hook', agent_id: 'local-1', engine_session_id: 'eng-sess' }] }]
            },
            execute: async () => ({ rows: [] }),
        } as unknown as Client
        const engine = { baseUrl: 'http://127.0.0.1:41111', apiKey: 'fixture-only' }
        const first = await adoptDesktopTriggerSession(db, engine, {
            agentId: 'local-1', engineAgentId: 'eng-1', engineSessionId: 'eng-sess', runId: 'run-1',
        })
        expect(first.tabUid).toBe('trigger:local-sess')
        expect(first.sessionId).toBe('local-sess')

        vi.mocked(getSession).mockResolvedValueOnce({ id: 'eng-sess', agentId: 'eng-1', source: 'schedule', title: 'Nope', status: 'idle', originAgentId: null, originSessionId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
        await expect(adoptDesktopTriggerSession(db, engine, {
            agentId: 'local-1', engineAgentId: 'eng-1', engineSessionId: 'eng-sess',
        })).rejects.toMatchObject({ status: 409 })
    })
})
