import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    text: '{"mode":"cron","cron":"0 8 * * 1-5","label":"Weekdays at 8"}',
    noObjectText: null as string | null,
    usable: true,
    sameConnection: true,
}))
const mocks = vi.hoisted(() => ({
    authorize: vi.fn(), resolvePin: vi.fn(), resolveDefault: vi.fn(), resolveRunModel: vi.fn(), isUsable: vi.fn(), assertProvider: vi.fn(),
    getAgent: vi.fn(), modelFor: vi.fn(), findConnection: vi.fn(), beginWork: vi.fn(), ensureAuth: vi.fn(), generateText: vi.fn(),
    releaseWork: vi.fn(), releaseAuth: vi.fn(),
}))

vi.mock('./schedule-binding.js', () => ({ authorizeDesktopSchedule: mocks.authorize }))
vi.mock('./schedule-model.js', () => ({ resolveDesktopScheduleModel: mocks.resolvePin }))
vi.mock('../agents/availability.js', () => ({ resolveConfiguredModel: mocks.resolveDefault, resolveRunModel: mocks.resolveRunModel, isUsable: mocks.isUsable }))
vi.mock('./policy.js', () => ({ assertDesktopProvider: mocks.assertProvider }))
vi.mock('../agents/registry.js', () => ({ getAgent: mocks.getAgent }))
vi.mock('../agents/providers.js', () => ({ modelFor: mocks.modelFor }))
vi.mock('../connections/registry.js', () => ({ findConnection: mocks.findConnection }))
vi.mock('../connections/cli-auth.js', () => ({ ensureCliAuth: mocks.ensureAuth }))
vi.mock('./api-connections/admission.js', () => ({ beginDesktopApiConnectionWork: mocks.beginWork }))
vi.mock('ai', () => ({
    generateText: mocks.generateText,
    Output: { object: (value: unknown) => value },
    NoObjectGeneratedError: { isInstance: () => state.noObjectText !== null },
}))

import { describeDesktopSchedule } from './schedule-description.js'

const input = { description: 'weekdays at 8', nowIso: '2026-11-09T12:00:00-06:00', timezone: 'America/Chicago', connectionId: null, provider: null, model: null }
const exactInput = { ...input, connectionId: 'conn-b', provider: 'openai' as const, model: 'gpt-exact' }
const agent = { id: 'agent-a', config: { connectionId: null, provider: null, model: null }, resolved: { provider: 'openai', model: 'default-model', connection: { id: 'default' } } }
const defaultResolution = { provider: 'openai', model: 'default-model' }
const connections = new Map<string, { id: string }>()
function connectionFor(id: string) {
    if (!connections.has(id)) connections.set(id, { id })
    return connections.get(id)!
}

beforeEach(() => {
    vi.clearAllMocks()
    connections.clear()
    state.text = '{"mode":"cron","cron":"0 8 * * 1-5","label":"Weekdays at 8"}'
    state.noObjectText = null
    state.usable = true
    state.sameConnection = true
    mocks.authorize.mockResolvedValue(undefined)
    mocks.getAgent.mockResolvedValue(agent)
    mocks.resolveDefault.mockImplementation(async () => ({ ...defaultResolution, connection: connectionFor('default') }))
    mocks.resolveRunModel.mockImplementation(async (_agent, override: { connectionId: string; provider: string; model: string }) => ({ connection: connectionFor(override.connectionId), provider: override.provider, model: override.model }))
    mocks.resolvePin.mockImplementation(async (_agent, current: { connectionId: string | null; provider: string | null; model: string | null }) => ({ connectionId: current.connectionId, provider: current.provider, model: current.model }))
    mocks.isUsable.mockImplementation(() => state.usable)
    mocks.beginWork.mockReturnValue(mocks.releaseWork)
    mocks.ensureAuth.mockResolvedValue(mocks.releaseAuth)
    mocks.modelFor.mockReturnValue('language-model')
    mocks.findConnection.mockImplementation(async (id: string) => state.sameConnection ? connectionFor(id) : { id: 'other' })
    mocks.generateText.mockImplementation(async () => {
        if (state.noObjectText !== null) {
            const error = new Error('No object generated') as Error & { text: string }
            error.text = state.noObjectText
            throw error
        }
        return { text: state.text }
    })
})

describe('describeDesktopSchedule output validation', () => {
    it('returns a recurring result', async () => {
        await expect(describeDesktopSchedule('agent-a', input)).resolves.toEqual({
            status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5', label: 'Weekdays at 8' },
        })
    })

    it('returns a one-time result with an explicit offset', async () => {
        state.text = '{"mode":"runAt","runAt":"2026-11-10T08:00:00-06:00"}'
        await expect(describeDesktopSchedule('agent-a', input)).resolves.toEqual({
            status: 'ok', value: { mode: 'runAt', runAt: '2026-11-10T08:00:00-06:00' },
        })
    })

    it.each([
        ['not json', 'not json'],
        ['wrong mode', '{"mode":"sometimes","runAt":"2026-11-10T08:00:00Z"}'],
        ['invalid cron', '{"mode":"cron","cron":"bad"}'],
        ['runAt without offset', '{"mode":"runAt","runAt":"2026-11-10T08:00:00"}'],
        ['invalid timezone', '{"mode":"cron","cron":"0 8 * * *","timezone":"Not/AZone"}'],
        ['unexpected fields', '{"mode":"cron","cron":"0 8 * * *","extra":true}'],
    ])('reports invalid output: %s', async (_kind, text) => {
        state.text = text
        await expect(describeDesktopSchedule('agent-a', input)).resolves.toMatchObject({ status: 'invalid' })
    })

    it('validates native structured-output error text as invalid rather than hiding it as an outage', async () => {
        state.noObjectText = '{"mode":"cron","cron":"bad"}'
        await expect(describeDesktopSchedule('agent-a', input)).resolves.toMatchObject({ status: 'invalid' })
    })
})

describe('describeDesktopSchedule authority and lifecycle', () => {
    it('uses canonical coworker-default resolution and releases auth and connection work', async () => {
        await describeDesktopSchedule('agent-a', input)

        expect(mocks.resolveDefault).toHaveBeenCalledWith(agent.config)
        expect(mocks.resolvePin).not.toHaveBeenCalled()
        expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
            model: 'language-model', maxOutputTokens: 1000, maxRetries: 0, abortSignal: expect.any(AbortSignal),
        }))
        expect(mocks.releaseAuth).toHaveBeenCalledTimes(1)
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })

    it('uses the exact current routine selection without default substitution', async () => {
        await describeDesktopSchedule('agent-a', exactInput)

        expect(mocks.resolvePin).toHaveBeenCalledWith(agent, exactInput)
        expect(mocks.resolveDefault).not.toHaveBeenCalled()
        expect(mocks.assertProvider).toHaveBeenCalledWith('openai', 'conn-b')
        expect(mocks.releaseAuth).toHaveBeenCalledTimes(1)
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })

    it('reports an unavailable connection without calling the model', async () => {
        state.usable = false

        await expect(describeDesktopSchedule('agent-a', input)).resolves.toMatchObject({ status: 'unavailable' })
        expect(mocks.generateText).not.toHaveBeenCalled()
        expect(mocks.ensureAuth).not.toHaveBeenCalled()
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })

    it('propagates workspace denial before model work', async () => {
        mocks.authorize.mockRejectedValue(new Error('workspace denied'))

        await expect(describeDesktopSchedule('agent-a', input)).rejects.toThrow('workspace denied')
        expect(mocks.getAgent).not.toHaveBeenCalled()
        expect(mocks.generateText).not.toHaveBeenCalled()
    })

    it('does not authorize or complete an already-aborted preview', async () => {
        const controller = new AbortController()
        controller.abort()

        await expect(describeDesktopSchedule('agent-a', input, controller.signal)).rejects.toThrow()
        expect(mocks.authorize).not.toHaveBeenCalled()
        expect(mocks.generateText).not.toHaveBeenCalled()
    })

    it('propagates abort during generation without turning it into a preview', async () => {
        const controller = new AbortController()
        mocks.generateText.mockImplementation(async () => { controller.abort(); throw new Error('aborted') })

        await expect(describeDesktopSchedule('agent-a', input, controller.signal)).rejects.toThrow('aborted')
        expect(mocks.releaseAuth).toHaveBeenCalledTimes(1)
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })

    it('refuses a changed connection after generation', async () => {
        state.sameConnection = false

        await expect(describeDesktopSchedule('agent-a', input)).resolves.toMatchObject({ status: 'unavailable' })
        expect(mocks.releaseAuth).toHaveBeenCalledTimes(1)
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })
})


it('rejects an invalid editor timezone before authorization or model work', async () => {
    await expect(describeDesktopSchedule('agent-a', { ...input, timezone: 'Not/AZone' })).rejects.toThrow()
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.generateText).not.toHaveBeenCalled()
})
