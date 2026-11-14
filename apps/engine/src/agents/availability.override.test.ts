import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveConnection = vi.fn()
vi.mock('../connections/resolve.js', () => ({ resolveConnection, servesModel: () => true }))
vi.mock('../connections/plan.js', () => ({ allowedModel: (_provider: string, model: string) => model }))

const { resolveRunModel } = await import('./availability.js')
type Agent = Parameters<typeof resolveRunModel>[0]

const KIMI = 'mac-kimi-code-19576ec2-652e-4023-9d2d-7e7e2954415f'
const kimi = { id: KIMI, config: { provider: 'kimi-code' }, env: {} }
// A coworker pinned to a custom endpoint, as the owner's was when a chat was switched to Kimi.
const pinned = { config: { connectionId: '19151a96-0f83-4b06-b9d6-18db9de57a0d', provider: 'custom', model: 'deepseek' }, resolved: { connection: null, provider: 'custom', model: 'deepseek' } } as unknown as Agent

beforeEach(() => { resolveConnection.mockReset() })

describe('a run switched to another connection', () => {
    it('looks the named connection up on its own, not under the coworker’s pinned provider', async () => {
        resolveConnection.mockResolvedValue(kimi)
        const run = await resolveRunModel(pinned, { connectionId: KIMI, model: 'kimi-code/k3.1-pro' })
        expect(resolveConnection).toHaveBeenCalledExactlyOnceWith(KIMI, undefined)
        expect(run).toMatchObject({ connection: kimi, provider: 'kimi-code', model: 'kimi-code/k3.1-pro' })
    })

    it('still reads the coworker’s own connection under its pinned provider when only the model changes', async () => {
        resolveConnection.mockResolvedValue(null)
        await resolveRunModel(pinned, { model: 'other' })
        expect(resolveConnection).toHaveBeenCalledExactlyOnceWith('19151a96-0f83-4b06-b9d6-18db9de57a0d', 'custom')
    })
})
