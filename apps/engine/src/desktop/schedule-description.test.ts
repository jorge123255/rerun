import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    text: '{"mode":"cron","cron":"0 8 * * 1-5","label":"Weekdays at 8"}',
    noObjectText: null as string | null,
    usable: true,
    sameConnection: true,
    currentRevision: 'a'.repeat(64),
}))
const mocks = vi.hoisted(() => ({
    authorize: vi.fn(), resolvePin: vi.fn(), resolveDefault: vi.fn(), resolveRunModel: vi.fn(), isUsable: vi.fn(), assertProvider: vi.fn(),
    readSchedule: vi.fn(), revision: vi.fn(),
    getAgent: vi.fn(), modelFor: vi.fn(), findConnection: vi.fn(), beginWork: vi.fn(), ensureAuth: vi.fn(), generateText: vi.fn(),
    releaseWork: vi.fn(), releaseAuth: vi.fn(),
}))

vi.mock('./schedule-binding.js', () => ({ authorizeDesktopSchedule: mocks.authorize }))
vi.mock('./schedule-model.js', () => ({ resolveDesktopScheduleModel: mocks.resolvePin }))
vi.mock('../schedules/loader.js', () => ({ readSchedule: mocks.readSchedule }))
vi.mock('./schedule-tools/revision.js', () => ({ desktopScheduleDefinitionRevision: mocks.revision }))
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
const connections = new Map<string, { id: string; config: { provider: string } }>()
function connectionFor(id: string) {
    if (!connections.has(id)) connections.set(id, { id, config: { provider: 'openai' } })
    return connections.get(id)!
}

beforeEach(() => {
    vi.clearAllMocks()
    connections.clear()
    state.text = '{"mode":"cron","cron":"0 8 * * 1-5","label":"Weekdays at 8"}'
    state.noObjectText = null
    state.usable = true
    state.sameConnection = true
    state.currentRevision = 'a'.repeat(64)
    mocks.readSchedule.mockResolvedValue({ connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' })
    mocks.revision.mockImplementation(() => state.currentRevision)
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

    it.each([
        ['opencode', 'opencode-desktop', { opencode: { workspaceId: 1, revision: 'rev-1' } }],
        ['grok-build', 'mac-grok-build-6f1833e1-4567-4f18-9e55-31c88dcc7813', {}],
        ['kimi-code', 'mac-kimi-code-6f1833e1-4567-4f18-9e55-31c88dcc7813', {}],
    ] as const)('accepts a fresh projection of the same %s connection', async (provider, id, fields) => {
        const connection = { id, config: { provider }, ...fields }
        mocks.resolveRunModel.mockResolvedValue({ connection, provider, model: 'exact' })
        mocks.findConnection.mockImplementation(async () => structuredClone(connection))

        await expect(describeDesktopSchedule('agent-a', { ...input, connectionId: id, provider, model: 'exact' }))
            .resolves.toMatchObject({ status: 'ok' })
        expect(mocks.generateText).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['revision', { workspaceId: 1, revision: 'rev-2' }],
        ['workspace', { workspaceId: 2, revision: 'rev-1' }],
    ] as const)('refuses a different OpenCode %s before dispatch', async (_case, latest) => {
        const connection = { id: 'opencode-desktop', config: { provider: 'opencode' }, opencode: { workspaceId: 1, revision: 'rev-1' } }
        mocks.resolveRunModel.mockResolvedValue({ connection, provider: 'opencode', model: 'exact' })
        mocks.findConnection.mockResolvedValue({ ...connection, opencode: latest })

        await expect(describeDesktopSchedule('agent-a', { ...input, connectionId: connection.id, provider: 'opencode', model: 'exact' }))
            .resolves.toMatchObject({ status: 'unavailable' })
        expect(mocks.generateText).not.toHaveBeenCalled()
        expect(mocks.releaseAuth).toHaveBeenCalledTimes(1)
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })

    it('rejects a subscription preview when the selected model is no longer offered', async () => {
        const provider = 'kimi-code'
        const connection = { id: 'mac-kimi-code-6f1833e1-4567-4f18-9e55-31c88dcc7813', config: { provider } }
        mocks.resolveRunModel.mockResolvedValue({ connection, provider, model: 'exact' })
        mocks.findConnection.mockImplementation(async () => structuredClone(connection))
        mocks.generateText.mockImplementation(async () => {
            state.usable = false
            return { text: state.text }
        })

        await expect(describeDesktopSchedule('agent-a', { ...input, connectionId: connection.id, provider, model: 'exact' }))
            .resolves.toMatchObject({ status: 'unavailable' })
        expect(mocks.generateText).toHaveBeenCalledTimes(1)
    })

    it('does not dispatch if cancelled while authentication is preparing', async () => {
        const controller = new AbortController()
        mocks.ensureAuth.mockImplementation(async () => {
            controller.abort(new Error('preview cancelled during authentication'))
            return mocks.releaseAuth
        })

        await expect(describeDesktopSchedule('agent-a', input, controller.signal))
            .rejects.toThrow('preview cancelled during authentication')
        expect(mocks.generateText).not.toHaveBeenCalled()
        expect(mocks.releaseAuth).toHaveBeenCalledTimes(1)
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })

    it('refuses a changed connection after generation', async () => {
        mocks.generateText.mockImplementation(async () => {
            state.sameConnection = false
            return { text: state.text }
        })

        await expect(describeDesktopSchedule('agent-a', input)).resolves.toMatchObject({ status: 'unavailable' })
        expect(mocks.generateText).toHaveBeenCalledTimes(1)
        expect(mocks.releaseAuth).toHaveBeenCalledTimes(1)
        expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    })
})


it('rejects an invalid editor timezone before authorization or model work', async () => {
    await expect(describeDesktopSchedule('agent-a', { ...input, timezone: 'Not/AZone' })).rejects.toThrow()
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.generateText).not.toHaveBeenCalled()
})


describe('saved Foreman routine model and revision', () => {
    const revision = 'a'.repeat(64)
    const foremanInput = { ...input, slug: 'daily', expectedRevision: revision }

    it('uses the stored exact model and rechecks the same revision after generation', async () => {
        await expect(describeDesktopSchedule('agent-a', foremanInput)).resolves.toMatchObject({ status: 'ok' })

        expect(mocks.resolvePin).toHaveBeenCalledWith(agent, expect.objectContaining({ connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' }))
        expect(mocks.resolveDefault).not.toHaveBeenCalled()
        expect(mocks.readSchedule).toHaveBeenCalledTimes(2)
    })

    it('rejects a stale routine revision before loading the agent or model', async () => {
        state.currentRevision = 'b'.repeat(64)

        await expect(describeDesktopSchedule('agent-a', foremanInput)).resolves.toMatchObject({ status: 'invalid' })
        expect(mocks.getAgent).not.toHaveBeenCalled()
        expect(mocks.generateText).not.toHaveBeenCalled()
        expect(mocks.resolveDefault).not.toHaveBeenCalled()
    })

    it('rejects a revision that changes during generation', async () => {
        mocks.revision.mockImplementationOnce(() => revision).mockImplementationOnce(() => 'b'.repeat(64))

        await expect(describeDesktopSchedule('agent-a', foremanInput)).resolves.toMatchObject({ status: 'invalid' })
        expect(mocks.readSchedule).toHaveBeenCalledTimes(2)
        expect(mocks.generateText).toHaveBeenCalledTimes(1)
    })

    it.each([
        [{ slug: 'daily' }],
        [{ expectedRevision: revision }],
        [{ slug: 'daily', expectedRevision: revision, connectionId: 'client-connection' }],
        [{ slug: 'daily', expectedRevision: revision, provider: 'openai' }],
        [{ slug: 'daily', expectedRevision: revision, model: 'client-model' }],
    ])('rejects unauthorized or incomplete routine identity: %j', async identity => {
        await expect(describeDesktopSchedule('agent-a', { ...input, ...identity })).rejects.toThrow()
        expect(mocks.authorize).not.toHaveBeenCalled()
        expect(mocks.generateText).not.toHaveBeenCalled()
    })
})
