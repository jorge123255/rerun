import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
const state = vi.hoisted(() => {
    class RequestError extends Error { constructor(readonly status: number) { super('private engine diagnostic') } }
    return { RequestError, status: 409 }
})
vi.mock('@/lib/engine/client', () => ({ EngineRequestError: state.RequestError, request: async () => { throw new state.RequestError(state.status) }, getAgent: vi.fn(), listLatestScheduleRuns: vi.fn() }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('../store', () => ({ findDesktopAgent: async () => ({ id: 'local-a', engineAgentId: 'engine-a', enabled: true }), listDesktopAgents: async () => [] }))
vi.mock('../settings', () => ({ engineOf: () => ({ baseUrl: 'http://127.0.0.1:12345', apiKey: 'fake' }) }))
vi.mock('../schedules-binding', () => ({ authorizeDesktopSchedules: async () => {} }))
vi.mock('../schedules/adoption', () => ({ adoptDesktopScheduledSession: vi.fn() }))
import { desktopWorkspaceRoutinesAuthority } from './runtime'
afterEach(() => { state.status = 409 })
it.each([403, 404, 409, 503])('keeps expected engine refusal %i typed and useful without leaking diagnostics', async status => {
    state.status = status
    const authority = await desktopWorkspaceRoutinesAuthority({ dataRoot: '/test-only' } as DesktopRuntime)
    const work = authority.receipt({ action: 'run', agentId: 'local-a', slug: 'daily', expectedRevision: 'v1', requestId: '00000000-0000-4000-8000-000000000001' })
    await expect(work).rejects.toMatchObject({ status })
    await expect(work).rejects.not.toThrow('private engine diagnostic')
})
