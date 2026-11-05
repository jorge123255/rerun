import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../auth', () => ({
    DesktopHttpError: class DesktopHttpError extends Error { constructor(public status: number, message: string) { super(message) } },
}))
vi.mock('../database', () => ({ openDesktopDatabase: vi.fn() }))
vi.mock('../settings', () => ({ engineOf: () => ({}) }))
vi.mock('../roster-writes', () => ({ withRosterWrite: async (fn: any) => fn() }))
vi.mock('@/lib/engine/client', () => ({ getAgent: vi.fn() }))
vi.mock('./api', () => ({ desktopTriggersApi: vi.fn(() => async () => new Response('ok')) }))
vi.mock('./adoption', () => ({ adoptDesktopTriggerEvent: vi.fn() }))

describe('configureDesktopTriggersManagement', () => {
    beforeEach(async () => {
        const { configureDesktopTriggersManagement } = await import('./binding')
        configureDesktopTriggersManagement(null)
    })

    it('rejects memory-like incomplete stores and fails closed on request', async () => {
        const { configureDesktopTriggersManagement, desktopTriggerRequest } = await import('./binding')
        expect(() => configureDesktopTriggersManagement({ durable: { getRevision: async () => 'r1' } as any })).toThrow(/durable store/i)
        await expect(desktopTriggerRequest({ dataRoot: '/tmp', launchNonce: 'n' } as any, new Request('http://x'), 'a1')).rejects.toMatchObject({ status: 503 })
    })
})
