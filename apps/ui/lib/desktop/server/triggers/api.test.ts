import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ owner: vi.fn(), engine: vi.fn(), auth: vi.fn() }))
vi.mock('../auth', () => ({ authenticateDesktopRequest: mocks.auth, DesktopHttpError: class extends Error { constructor(public status: number, message: string) { super(message) } } }))
vi.mock('../store', () => ({ findDesktopAgent: mocks.owner }))
vi.mock('./engine', () => ({ desktopTriggerEngine: mocks.engine }))
vi.mock('./history', () => ({ projectDesktopTriggerHistory: async (_r: unknown, _d: unknown, _a: unknown, input: unknown) => input }))
vi.mock('./adoption', () => ({ adoptDesktopTriggerSession: vi.fn() }))
import { desktopTriggersApi } from './api'
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ launchNonce: 'launch' }); mocks.owner.mockResolvedValue({ id: 'local', engineAgentId: 'engine' }); mocks.engine.mockResolvedValue({ ok: true }) })
describe('desktop trigger management bridge', () => {
    it.each([
        ['POST', { action: 'rotate', slug: 'hook', requestId: 'id', expectedRevision: 'revision' }, 'rotate'],
        ['DELETE', { slug: 'hook', requestId: 'id', expectedRevision: 'revision' }, 'delete'],
        ['POST', { action: 'stop', requestId: 'id', localSessionId: 'session', runId: 'run', expectedEventId: 'event' }, 'stop'],
    ] as const)('routes %s %s through the durable engine lifecycle without action envelope pollution', async (method, body, op) => {
        const response = await desktopTriggersApi({} as never, async () => {})(new Request('http://local/triggers', { method, body: JSON.stringify(body) }), 'local')
        expect(response.status).toBe(200)
        const call = mocks.engine.mock.calls[0][1]
        expect(call.op).toBe(op); expect(call.localAgentId).toBe('local'); expect(call.engineAgentId).toBe('engine')
        expect(call.input.action).toBeUndefined(); expect(call.input.slug).toBeUndefined()
    })
    it('refuses a changed owner before sending any mutation', async () => {
        mocks.owner.mockResolvedValueOnce({ id: 'local', engineAgentId: 'engine' }).mockResolvedValueOnce({ id: 'local', engineAgentId: 'replacement' })
        const response = await desktopTriggersApi({} as never, async () => {})(new Request('http://local/triggers', { method: 'PUT', body: JSON.stringify({ name: 'Hook' }) }), 'local')
        expect(response.status).toBe(409); expect(mocks.engine).not.toHaveBeenCalled()
    })
    it('reads history through the same durable authority', async () => {
        await desktopTriggersApi({} as never, async () => {})(new Request('http://local/triggers?action=history&slug=hook'), 'local')
        expect(mocks.engine.mock.calls[0][1]).toMatchObject({ op: 'history', slug: 'hook' })
    })
})
