import { beforeEach, expect, it, vi } from 'vitest'
import { agentConfigSchema, type AgentConfig } from '@rerun/contracts'
import type { LoadedAgent } from '../agents/types.js'
import type { LoadedConnection } from '../connections/types.js'

const fixture = vi.hoisted(() => ({
    config: null as AgentConfig | null, connection: null as LoadedConnection | null,
    report: vi.fn(async () => 'No new leads were found. Nothing was changed.' as string | null),
    save: vi.fn(async () => {}),
    generate: vi.fn(async (_input: unknown) => ({ text: '{"title":"No new leads","nothingToReport":true}' })),
    model: vi.fn((_agent: LoadedAgent) => 'fixture-model'),
    release: vi.fn(),
}))
vi.mock('ai', () => ({ generateText: fixture.generate }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => fixture.config }))
vi.mock('../agents/providers.js', () => ({ modelFor: fixture.model }))
vi.mock('../connections/registry.js', () => ({ findConnection: async () => fixture.connection }))
vi.mock('../connections/cli-auth.js', () => ({ ensureCliAuth: async () => fixture.release }))
vi.mock('../db/desktop-automation-results.js', () => ({
    readUnlabelledAutomationReport: fixture.report, recordDesktopAutomationResult: fixture.save,
}))
vi.mock('./policy.js', () => ({ assertDesktopProvider: () => {}, desktopApp: () => true }))
vi.mock('../connections/loader.js', () => ({ isConnected: () => true }))

import { labelDesktopAutomationResult } from './automation-result.js'

const connection: LoadedConnection = {
    id: 'fixture-api', config: { name: 'Fixture', provider: 'openai', models: ['fixture-model'], extraModels: [], createdAt: '' }, env: {},
}
const config = (granted: boolean) => agentConfigSchema.parse({ name: 'Research', tools: { desktopToolGrants: { schedule: granted, trigger: granted } } })
const agent: LoadedAgent = { id: 'owner', soul: '', install: '', env: { IGNORE: 'agent secret' }, config: config(true),
    resolved: { connection, model: 'fixture-model', provider: 'openai' } }
const routine = { source: 'schedule', name: 'Daily lead check', slug: 'lead-check' } as const
const submit = (signal = new AbortController().signal, trigger: Parameters<typeof labelDesktopAutomationResult>[3] = routine) =>
    labelDesktopAutomationResult(agent, 'session', 'run', trigger, 0, signal)

beforeEach(() => {
    fixture.connection = connection
    fixture.config = config(true)
    vi.clearAllMocks()
})

it.each([
    [routine, 'No new leads', true, 'nothing'],
    [{ ...routine, source: 'trigger' } as const, 'Reviewed three leads', false, 'done'],
] as const)('labels an owned %j from its report using the exact run model', async (trigger, title, nothingToReport, outcome) => {
    fixture.generate.mockResolvedValueOnce({ text: JSON.stringify({ title: title + '.', nothingToReport }) })
    await submit(undefined, trigger)
    expect(fixture.model).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ env: {}, resolved: agent.resolved }))
    expect(fixture.generate).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, prompt: expect.stringContaining('No new leads were found') }))
    expect(fixture.generate.mock.calls[0]?.[0]).not.toHaveProperty('tools')
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith({ agentId: 'owner', sessionId: 'session', runId: 'run', source: trigger.source },
        { title, outcome }, expect.any(AbortSignal))
    expect(fixture.release).toHaveBeenCalledOnce()
})

it('does not start inference without a current completion receipt or a current grant', async () => {
    fixture.report.mockResolvedValueOnce(null)
    await submit()
    fixture.config = config(false)
    await submit()
    expect(fixture.generate).not.toHaveBeenCalled()
    expect(fixture.save).not.toHaveBeenCalled()
})

it.each(['malformed', 'revoked', 'replaced', 'stopped'] as const)('leaves the saved completion alone when labeling is %s', async reason => {
    const controller = new AbortController()
    fixture.generate.mockImplementationOnce(async () => {
        if (reason === 'revoked') fixture.config = config(false)
        if (reason === 'replaced') fixture.connection = { ...connection }
        if (reason === 'stopped') controller.abort()
        return { text: reason === 'malformed' ? '{"title":"Unknown"}' : '{"title":"No new leads","nothingToReport":true}' }
    })
    await submit(controller.signal)
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.release).toHaveBeenCalledOnce()
})
