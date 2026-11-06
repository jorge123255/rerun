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

const runtime = { launchNonce: 'current', dataRoot: '/tmp' } as never
const modelInput = { engineAgentId: 'engine', override: { connectionId: null, provider: null, model: null } }
const bridge = (op: 'owner' | 'authorize' | 'setup' | 'model') => handleDesktopTriggerBridge(runtime, {
    event: 'desktop.trigger', launchNonce: 'current', op,
    payload: op === 'model' ? modelInput : { engineAgentId: 'engine' },
})
beforeEach(() => {
    vi.resetAllMocks()
    mocks.db.execute.mockImplementation(async (query: { sql: string }) => ({ rows: query.sql.includes('LEFT JOIN') ? [{ id: 'local', enabled: 1, deleting: null }] : [] }))
    mocks.owner.mockResolvedValue({ id: 'local', engineAgentId: 'engine', enabled: true })
    mocks.detail.mockResolvedValue({ id: 'engine', config: { enabled: true, tools: { desktopToolGrants: { trigger: false } } } })
    mocks.setup.mockResolvedValue(undefined)
    mocks.model.mockResolvedValue({ connectionId: 'connection', model: 'chosen-model' })
})
describe('trigger callback authority', () => {
    it('refuses a stale engine launch before reading any owner', async () => {
        await expect(handleDesktopTriggerBridge({ launchNonce: 'current' } as never, { event: 'desktop.trigger', launchNonce: 'old', op: 'owner', payload: { engineAgentId: 'engine' } })).rejects.toMatchObject({ status: 409 })
        expect(mocks.db.execute).not.toHaveBeenCalled()
    })
    it('does not treat identity-only reads as permission for model trigger tools', async () => {
        const owner = await bridge('owner')
        expect((await owner!.json()).result.localAgentId).toBe('local')
        await expect(bridge('authorize')).rejects.toMatchObject({ status: 403, message: 'Enable Triggers in this coworker’s Tools' })
    })

    it('admits human trigger setup and model resolution without model tool permission', async () => {
        expect(await (await bridge('setup'))!.json()).toMatchObject({ ok: true, result: { localAgentId: 'local', enabled: true } })
        expect(await (await bridge('model'))!.json()).toEqual({ ok: true, result: { connectionId: 'connection', model: 'chosen-model' } })
        expect(mocks.model).toHaveBeenCalledTimes(1)
        expect(mocks.detail).toHaveBeenCalledTimes(3)
        expect(mocks.setup).toHaveBeenCalledTimes(3)
        await expect(bridge('authorize')).rejects.toMatchObject({ status: 403 })
    })

    it.each(['setup', 'model', 'authorize'] as const)('reports a disabled local coworker separately from tool permission during %s', async op => {
        mocks.owner.mockResolvedValue({ id: 'local', engineAgentId: 'engine', enabled: false })
        await expect(bridge(op)).rejects.toMatchObject({ status: 403, message: 'Enable this coworker to run triggers' })
        expect(mocks.model).not.toHaveBeenCalled()
        expect(mocks.setup).not.toHaveBeenCalled()
    })

    it('refuses an engine-disabled coworker before model resolution even with a model tool grant', async () => {
        mocks.detail.mockResolvedValue({ id: 'engine', config: { enabled: false, tools: { desktopToolGrants: { trigger: true } } } })
        await expect(bridge('model')).rejects.toMatchObject({ status: 403, message: 'Enable this coworker to run triggers' })
        expect(mocks.model).not.toHaveBeenCalled()
    })

    it.each(['local', 'engine'] as const)('rechecks the %s enabled state after awaited model resolution', async location => {
        mocks.model.mockImplementation(async () => {
            if (location === 'local') mocks.owner.mockResolvedValue({ id: 'local', engineAgentId: 'engine', enabled: false })
            else mocks.detail.mockResolvedValue({ id: 'engine', config: { enabled: false, tools: {} } })
            return { connectionId: 'connection', model: 'chosen-model' }
        })
        await expect(bridge('model')).rejects.toMatchObject({ status: 403, message: 'Enable this coworker to run triggers' })
        expect(mocks.model).toHaveBeenCalledTimes(1)
        expect(mocks.detail).toHaveBeenCalledTimes(2)
        expect(mocks.setup).toHaveBeenCalledTimes(1)
    })

    it('rechecks exact owner mapping after awaited model resolution', async () => {
        mocks.model.mockImplementation(async () => {
            mocks.db.execute.mockImplementation(async (query: { sql: string }) => ({ rows: query.sql.includes('LEFT JOIN') ? [{ id: 'replacement', enabled: 1, deleting: null }] : [] }))
            mocks.owner.mockResolvedValue({ id: 'replacement', engineAgentId: 'engine', enabled: true })
            return { connectionId: 'connection', model: 'chosen-model' }
        })
        await expect(bridge('model')).rejects.toMatchObject({ status: 409, message: 'Coworker identity changed' })
    })

    it('still requires setup to be clear after model resolution', async () => {
        mocks.setup.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Setup pending'))
        await expect(bridge('model')).rejects.toThrow('Setup pending')
        expect(mocks.model).toHaveBeenCalledTimes(1)
        expect(mocks.setup).toHaveBeenCalledTimes(2)
    })

    it('rechecks a model tool grant instead of retaining a previous authorization', async () => {
        mocks.detail.mockResolvedValueOnce({ id: 'engine', config: { enabled: true, tools: { desktopToolGrants: { trigger: true } } } })
        expect(await (await bridge('authorize'))!.json()).toMatchObject({ ok: true, result: { enabled: true } })
        await expect(bridge('authorize')).rejects.toMatchObject({ status: 403, message: 'Enable Triggers in this coworker’s Tools' })
    })
})
