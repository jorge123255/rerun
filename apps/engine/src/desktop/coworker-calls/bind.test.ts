import { beforeEach, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
    deps: null as null | { startChildRun: (input: {
        originAgentId?: string
        engineTargetAgentId: string
        engineSessionId: string
        prompt: string
        model: { connectionId: string; model: string }
        assertActive: () => Promise<void>
        onRunCreated: (runId: string) => Promise<void>
    }) => Promise<{ engineRunId: string; follow: { runId: string } }> },
    startHeadlessRun: vi.fn(),
    getAgent: vi.fn(),
}))

vi.mock('./http-store.js', () => ({
    createHttpCoworkerCallBridge: () => ({
        store: { adoptEpoch: async () => undefined },
        authorize: async () => ({ ok: false, reason: 'unused' }),
        prepareTarget: async () => { throw new Error('unused') },
        adoptPublicSession: async () => { throw new Error('unused') },
    }),
}))
vi.mock('./runtime.js', () => ({
    createDesktopCoworkerCallRuntime: (deps: NonNullable<typeof captured.deps>) => {
        captured.deps = deps
        return { execute: async () => ({ text: '' }) }
    },
}))
vi.mock('../../runtime/headless-run.js', () => ({ startHeadlessRun: captured.startHeadlessRun }))
vi.mock('../../agents/registry.js', () => ({ getAgent: captured.getAgent }))

import { bindDesktopCoworkerCalls } from './bind.js'

const runtime = { launchNonce: 'launch', app: { origin: 'http://127.0.0.1:9' }, engine: { apiKey: 'key' } }

beforeEach(() => {
    captured.deps = null
    captured.startHeadlessRun.mockReset()
    captured.startHeadlessRun.mockResolvedValue({ runId: 'run-bob', settled: Promise.resolve({ kind: 'done' }) })
    captured.getAgent.mockReset()
    captured.getAgent.mockImplementation(async (id: string) => ({ id, config: { name: 'Bob', enabled: true, selfImprovement: { enabled: true }, tools: { callAgent: true } } }))
})

it('starts the called coworker with calledBy set to the caller id', async () => {
    await bindDesktopCoworkerCalls(runtime)
    const assertActive = vi.fn(async () => undefined)
    const onRunCreated = vi.fn(async () => undefined)
    const started = await captured.deps!.startChildRun({
        originAgentId: 'engine-caller',
        engineTargetAgentId: 'engine-bob',
        engineSessionId: 'session-bob',
        prompt: 'What do we sell?',
        model: { connectionId: 'connection-bob', model: 'model-bob' },
        assertActive,
        onRunCreated,
    })
    expect(started).toEqual({ engineRunId: 'run-bob', follow: expect.objectContaining({ runId: 'run-bob' }) })
    expect(captured.getAgent).toHaveBeenCalledWith('engine-bob')
    expect(captured.startHeadlessRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'engine-bob', config: expect.objectContaining({ selfImprovement: { enabled: false } }) }),
        'session-bob',
        'What do we sell?',
        { connectionId: 'connection-bob', model: 'model-bob' },
        { source: 'chat', calledBy: 'engine-caller' },
        { beforeLaunch: assertActive, onRunCreated },
    )
})

it('does not invent calledBy when the desktop caller id is absent', async () => {
    await bindDesktopCoworkerCalls(runtime)
    await captured.deps!.startChildRun({
        engineTargetAgentId: 'engine-bob',
        engineSessionId: 'session-bob',
        prompt: 'What do we sell?',
        model: { connectionId: 'connection-bob', model: 'model-bob' },
        assertActive: async () => undefined,
        onRunCreated: async () => undefined,
    })
    expect(captured.startHeadlessRun.mock.calls[0][4]).toEqual({ source: 'chat' })
    expect(captured.startHeadlessRun.mock.calls[0][4]).not.toHaveProperty('calledBy')
})
