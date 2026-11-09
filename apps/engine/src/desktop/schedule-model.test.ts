import type { Provider } from '@rerun/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoadedAgent } from '../agents/types.js'
import type { Schedule } from '../schedules/loader.js'

const availability = vi.hoisted(() => ({ resolveRunModel: vi.fn(), isUsable: vi.fn() }))
vi.mock('../agents/availability.js', () => availability)

import { resolveDesktopScheduleModel } from './schedule-model.js'

const agent = { id: 'agent-a' } as LoadedAgent

function schedule(patch: Partial<Schedule>): Schedule {
    return {
        slug: 'daily', name: 'Daily', description: '', enabled: true, cron: '0 8 * * *', runAt: null,
        timezone: 'UTC', lastRunAt: null, connectionId: null, provider: null, model: null,
        body: 'Report', createdAt: '2026-01-01T00:00:00.000Z', ...patch,
    }
}

describe('resolveDesktopScheduleModel', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        availability.isUsable.mockReturnValue(true)
        availability.resolveRunModel.mockImplementation(async (_agent, requested: { connectionId: string; provider: Provider; model: string }) => ({
            connection: { id: requested.connectionId }, provider: requested.provider, model: requested.model,
        }))
    })

    it('uses coworker-default resolution only for an all-null legacy triple', async () => {
        await expect(resolveDesktopScheduleModel(agent, schedule({}))).resolves.toBeUndefined()
        expect(availability.resolveRunModel).not.toHaveBeenCalled()
    })

    it.each([
        { connectionId: null, provider: 'openai' as const, model: 'gpt-exact' },
        { connectionId: 'conn-b', provider: null, model: 'gpt-exact' },
        { connectionId: 'conn-b', provider: 'openai' as const, model: null },
    ])('refuses an incomplete stored selection without resolution: %j', async fields => {
        await expect(resolveDesktopScheduleModel(agent, schedule(fields))).rejects.toMatchObject({
            status: 409, message: 'This routine’s saved model selection is incomplete.',
        })
        expect(availability.resolveRunModel).not.toHaveBeenCalled()
    })

    it('returns the exact connected selection', async () => {
        const requested = { connectionId: 'conn-b', provider: 'openai' as const, model: 'gpt-exact' }
        await expect(resolveDesktopScheduleModel(agent, schedule(requested))).resolves.toEqual(requested)
        expect(availability.resolveRunModel).toHaveBeenCalledWith(agent, requested)
    })

    it.each([
        ['connection', { connection: { id: 'conn-other' }, provider: 'openai', model: 'gpt-exact' }],
        ['provider', { connection: { id: 'conn-b' }, provider: 'anthropic', model: 'gpt-exact' }],
        ['plan-substituted model', { connection: { id: 'conn-b' }, provider: 'openai', model: 'gpt-trial' }],
    ])('refuses a %s mismatch instead of substituting', async (_kind, resolved) => {
        availability.resolveRunModel.mockResolvedValue(resolved)
        await expect(resolveDesktopScheduleModel(agent, schedule({ connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' })))
            .rejects.toMatchObject({ status: 409, message: 'This routine’s saved model is unavailable. Choose another model or Coworker default.' })
    })

    it('refuses a selection that is no longer connected and offered', async () => {
        availability.isUsable.mockReturnValue(false)
        await expect(resolveDesktopScheduleModel(agent, schedule({ connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' })))
            .rejects.toMatchObject({ status: 409 })
    })
})
