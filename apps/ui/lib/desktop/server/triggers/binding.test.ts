import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ db: { execute: vi.fn() }, detail: vi.fn(), owner: vi.fn(), setup: vi.fn(), model: vi.fn() }))
vi.mock('../auth', () => ({ DesktopHttpError: class extends Error { constructor(public status: number, message: string) { super(message) } } }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => mocks.db }))
vi.mock('../settings', () => ({ engineOf: () => ({}) }))
vi.mock('../store', () => ({ findDesktopAgent: mocks.owner }))
vi.mock('@/lib/engine/client', () => ({ getAgent: mocks.detail }))
vi.mock('../setup/service', () => ({ assertDesktopSetupChatAllowed: mocks.setup }))
vi.mock('../chat-model', () => ({ resolveDesktopChatModel: mocks.model }))
vi.mock('./api', () => ({ desktopTriggersApi: vi.fn() }))
vi.mock('./adoption', () => ({ adoptDesktopTriggerSession: vi.fn() }))
import { handleDesktopTriggerBridge } from './binding'
beforeEach(() => { vi.clearAllMocks(); mocks.db.execute.mockImplementation(async (query: { sql: string }) => ({ rows: query.sql.includes('LEFT JOIN') ? [{ id: 'local', enabled: 1, deleting: null }] : [] })); mocks.owner.mockResolvedValue({ id: 'local', engineAgentId: 'engine', enabled: true }); mocks.detail.mockResolvedValue({ id: 'engine', config: { enabled: true, tools: {} } }) })
describe('trigger callback authority', () => {
    it('refuses a stale engine launch before reading any owner', async () => {
        await expect(handleDesktopTriggerBridge({ launchNonce: 'current' } as never, { event: 'desktop.trigger', launchNonce: 'old', op: 'owner', payload: { engineAgentId: 'engine' } })).rejects.toMatchObject({ status: 409 })
        expect(mocks.db.execute).not.toHaveBeenCalled()
    })
    it('does not treat identity-only reads as a trigger execution grant', async () => {
        const runtime = { launchNonce: 'current', dataRoot: '/tmp' } as never
        const owner = await handleDesktopTriggerBridge(runtime, { event: 'desktop.trigger', launchNonce: 'current', op: 'owner', payload: { engineAgentId: 'engine' } })
        expect((await owner!.json()).result.localAgentId).toBe('local')
        await expect(handleDesktopTriggerBridge(runtime, { event: 'desktop.trigger', launchNonce: 'current', op: 'authorize', payload: { engineAgentId: 'engine' } })).rejects.toMatchObject({ status: 403 })
    })
})
