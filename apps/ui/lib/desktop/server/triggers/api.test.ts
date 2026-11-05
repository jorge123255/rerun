import { describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({
    authenticateDesktopRequest: vi.fn(async () => ({ dataRoot: '/tmp', launchNonce: 'n' })),
    DesktopHttpError: class DesktopHttpError extends Error { constructor(public status: number, message: string) { super(message) } },
}))
vi.mock('../settings', () => ({ engineOf: () => ({ baseUrl: 'http://engine', apiKey: 'k' }) }))
vi.mock('../store', () => ({ findDesktopAgent: vi.fn(async () => ({ id: 'local-1', engineAgentId: 'eng-1' })) }))
vi.mock('./adoption', () => ({
    adoptDesktopTriggerSession: vi.fn(),
    recoverDesktopTriggerChats: vi.fn(async () => []),
}))

const engine = vi.hoisted(() => ({
    getAgent: vi.fn(async () => ({ id: 'eng-1', config: { enabled: true, tools: {} } })),
    listTriggers: vi.fn(async () => [{ slug: 'hook', name: 'Hook', description: '', enabled: true, methods: ['POST'], lastFiredAt: null, fireCount: 0, connectionId: null, provider: null, model: null, body: 'x', createdAt: 't', token: 'SECRET' }]),
    getTrigger: vi.fn(),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    rotateTriggerToken: vi.fn(),
    deleteTrigger: vi.fn(),
    cancelRun: vi.fn(),
}))

vi.mock('@/lib/engine/client', () => engine)

function durableStub(overrides: Partial<Record<string, unknown>> = {}) {
    const mutations = new Map<string, { kind: string; resultJson: string }>()
    return {
        getRevision: vi.fn(async () => 'r1'),
        bumpRevision: vi.fn(async () => 'r2'),
        findMutation: vi.fn(async (_e: string, id: string) => mutations.get(id) ?? null),
        rememberMutation: vi.fn(async (input: { requestId: string; kind: string; resultJson: string }) => {
            if (!mutations.has(input.requestId)) mutations.set(input.requestId, { kind: input.kind, resultJson: input.resultJson })
        }),
        listEvents: vi.fn(async () => []),
        ...overrides,
    }
}

describe('desktopTriggersApi durable authority', () => {
    it('fails closed when durable store is missing', async () => {
        const { desktopTriggersApi } = await import('./api')
        expect(() => desktopTriggersApi({} as any, async () => {}, null as any)).toThrow(/durable store/i)
    })

    it('lists triggers without leaking tokens and replays create request ids through durable receipts', async () => {
        const { desktopTriggersApi } = await import('./api')
        const durable = durableStub()
        const api = desktopTriggersApi({} as any, async () => {}, durable as any)
        const listed = await api(new Request('http://local/triggers', { method: 'GET' }), 'local-1')
        const body = await listed.json() as { triggers: Array<{ token?: string }> }
        expect(body.triggers[0].token).toBeUndefined()

        engine.createTrigger.mockResolvedValue({ slug: 'hook', name: 'Hook', description: '', enabled: true, methods: ['POST'], lastFiredAt: null, fireCount: 0, connectionId: null, provider: null, model: null, body: 'x', createdAt: 't', token: 'SECRET' })
        const requestId = '11111111-1111-4111-8111-111111111111'
        const created = await api(new Request('http://local/triggers', {
            method: 'PUT',
            body: JSON.stringify({ requestId, name: 'Hook', description: '', body: 'Do', methods: ['POST'], provider: null, model: null }),
        }), 'local-1')
        expect(created.status).toBe(201)
        expect(durable.rememberMutation).toHaveBeenCalled()

        const replay = await api(new Request('http://local/triggers', {
            method: 'PUT',
            body: JSON.stringify({ requestId, name: 'Hook', description: '', body: 'Do', methods: ['POST'], provider: null, model: null }),
        }), 'local-1')
        expect(engine.createTrigger).toHaveBeenCalledTimes(1)
        expect((await replay.json()).revision).toBe('r2')
    })

    it('history uses durable listEvents only', async () => {
        const { desktopTriggersApi } = await import('./api')
        const durable = durableStub({
            listEvents: vi.fn(async () => [{ eventId: 'e1', slug: 'hook', capturedPayload: true, liveOnly: false, status: 'finished' }]),
        })
        const api = desktopTriggersApi({} as any, async () => {}, durable as any)
        const res = await api(new Request('http://local/triggers?action=history&slug=hook', { method: 'GET' }), 'local-1')
        const items = await res.json()
        expect(items[0].eventId).toBe('e1')
        expect(durable.listEvents).toHaveBeenCalledWith('eng-1', 'hook')
    })
})
