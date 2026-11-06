import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeadlessRunLifecycle } from '../../runtime/headless-run.js'
import type { DesktopTriggerAuthority } from './types.js'

const mocks = vi.hoisted(() => ({
    getAgent: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getRun: vi.fn(),
    cancelRun: vi.fn(),
    setRunContext: vi.fn(),
    notify: vi.fn(),
    startHeadlessRun: vi.fn(),
    launched: vi.fn(),
    abortRun: vi.fn(),
    waitForRunCancellation: vi.fn(),
    beginWork: vi.fn(),
    release: vi.fn(),
    fetch: vi.fn(),
}))

vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../../agents/registry.js', () => ({ getAgent: mocks.getAgent }))
vi.mock('../../agents/loader.js', () => ({ listAgentIdsOnDisk: async () => [] }))
vi.mock('../../db/systemDb.js', () => ({ getSystemDb: vi.fn() }))
vi.mock('../../db/repos/sessions.js', () => ({ createSession: mocks.createSession, getSession: mocks.getSession }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: mocks.getRun, cancelRun: mocks.cancelRun, setRunContext: mocks.setRunContext }))
vi.mock('../../runtime/notify.js', () => ({ sendNotification: mocks.notify }))
vi.mock('../../runtime/headless-run.js', () => ({ startHeadlessRun: mocks.startHeadlessRun }))
vi.mock('../../runtime/run-control.js', () => ({ abortRun: mocks.abortRun, waitForRunCancellation: mocks.waitForRunCancellation }))
vi.mock('../../triggers/loader.js', () => ({ markFired: vi.fn() }))
vi.mock('../agent-lifecycle.js', () => ({ beginDesktopAgentWork: mocks.beginWork, desktopDeletionActive: () => false }))
vi.mock('./definitions.js', () => ({ listDesktopTriggerDefinitions: vi.fn(), readDesktopTriggerDefinition: vi.fn(), replaceDesktopTriggerDefinition: vi.fn() }))
vi.mock('./binding.js', () => ({
    bindDesktopTriggers: (input: { authority: DesktopTriggerAuthority }) => ({
        authority: input.authority,
        recoverOwner: async () => undefined,
        close: async () => undefined,
    }),
}))

import { createDesktopTriggerRuntime } from './runtime.js'

const runtimes: Awaited<ReturnType<typeof createDesktopTriggerRuntime>>[] = []
const model = { connectionId: 'connection-1', provider: null, model: 'model-1' }
const agent = () => ({ id: 'engine-1', config: { enabled: true, tools: { desktopToolGrants: { trigger: false } } }, resolved: { provider: 'openai' } })

function request() {
    return {
        engineAgentId: 'engine-1',
        slug: 'hook',
        name: 'Hook',
        message: 'Handle this delivery.',
        model,
        eventId: 'event-1',
        assertActive: vi.fn(async () => undefined),
        onSessionCreated: vi.fn(async (_sessionId: string) => undefined),
        onRunCreated: vi.fn(async (_runId: string, _sessionId: string) => undefined),
    }
}

async function runtime() {
    const result = await createDesktopTriggerRuntime({ launchNonce: 'launch-1', app: { origin: 'http://127.0.0.1:4321' }, engine: { apiKey: 'test-key' } }, { fetch: mocks.fetch })
    runtimes.push(result)
    return result
}

beforeEach(() => {
    vi.resetAllMocks()
    mocks.getAgent.mockResolvedValue(agent())
    mocks.createSession.mockResolvedValue({ id: 'session-1' })
    mocks.beginWork.mockReturnValue(mocks.release)
    mocks.fetch.mockImplementation(async () => Response.json({ ok: true, result: { connectionId: model.connectionId, model: model.model } }))
    mocks.getRun.mockResolvedValue({ id: 'run-1', agentId: 'engine-1', sessionId: 'session-1', status: 'running', triggerSource: 'trigger', triggerSlug: 'hook' })
    mocks.waitForRunCancellation.mockResolvedValue(true)
    mocks.startHeadlessRun.mockImplementation(async (_agent: unknown, _session: string, _message: string, _model: unknown, _trigger: unknown, lifecycle: HeadlessRunLifecycle) => {
        await lifecycle.beforeLaunch()
        await lifecycle.onRunCreated?.('run-1')
        await lifecycle.beforeLaunch()
        mocks.launched()
        return { runId: 'run-1', settled: Promise.resolve({ kind: 'done' as const }) }
    })
})

afterEach(async () => {
    for (const current of runtimes.splice(0)) await current.close()
})

describe('desktop trigger run authority', () => {
    it('starts a configured trigger for an enabled coworker without granting model trigger tools', async () => {
        const current = await runtime(), input = request()
        const started = await current.authority.startTriggerRun(input)
        await started.settled

        expect(started).toMatchObject({ runId: 'run-1', sessionId: 'session-1' })
        expect(mocks.createSession).toHaveBeenCalledWith('engine-1', 'Hook', undefined, 'trigger')
        expect(input.onSessionCreated).toHaveBeenCalledWith('session-1')
        expect(input.onRunCreated).toHaveBeenCalledWith('run-1', 'session-1')
        expect(mocks.setRunContext).toHaveBeenCalledWith('engine-1', 'run-1', { provider: 'openai', model: 'model-1', triggerSource: 'trigger', triggerSlug: 'hook' })
        expect(input.assertActive).toHaveBeenCalledTimes(3)
        expect(mocks.fetch).toHaveBeenCalledTimes(2)
        for (const [, options] of mocks.fetch.mock.calls) {
            expect(JSON.parse(options.body)).toMatchObject({ event: 'desktop.trigger', launchNonce: 'launch-1', op: 'model', payload: { engineAgentId: 'engine-1', override: model } })
        }
        expect((await mocks.getAgent.mock.results[0]!.value).config.tools.desktopToolGrants.trigger).toBe(false)
        expect(mocks.launched).toHaveBeenCalledOnce()
        expect(mocks.release).toHaveBeenCalledOnce()
    })

    it('reports a disabled coworker separately from a missing model-tool grant before creating a session', async () => {
        mocks.getAgent.mockResolvedValue({ ...agent(), config: { enabled: false, tools: { desktopToolGrants: { trigger: false } } } })
        const current = await runtime()

        await expect(current.authority.startTriggerRun(request())).rejects.toThrow('Enable this coworker to run triggers')
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(mocks.startHeadlessRun).not.toHaveBeenCalled()
        expect(mocks.fetch).not.toHaveBeenCalled()
        expect(mocks.release).toHaveBeenCalledOnce()
    })

    it('honors exact delivery admission before any session effect', async () => {
        const current = await runtime(), input = request()
        input.assertActive.mockRejectedValueOnce(new Error('Delivery stopped'))

        await expect(current.authority.startTriggerRun(input)).rejects.toThrow('Delivery stopped')
        expect(mocks.getAgent).not.toHaveBeenCalled()
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(mocks.startHeadlessRun).not.toHaveBeenCalled()
        expect(mocks.release).toHaveBeenCalledOnce()
    })

    it('rechecks admission after session creation and before launching the model', async () => {
        const current = await runtime(), input = request()
        input.assertActive.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Coworker identity changed'))

        await expect(current.authority.startTriggerRun(input)).rejects.toThrow('Coworker identity changed')
        expect(input.onSessionCreated).toHaveBeenCalledWith('session-1')
        expect(input.onRunCreated).not.toHaveBeenCalled()
        expect(mocks.fetch).not.toHaveBeenCalled()
        expect(mocks.launched).not.toHaveBeenCalled()
        expect(mocks.release).toHaveBeenCalledOnce()
    })

    it('rejects a changed automation model before creating a run', async () => {
        mocks.fetch.mockImplementation(async () => Response.json({ ok: true, result: { connectionId: 'connection-2', model: model.model } }))
        const current = await runtime(), input = request()

        await expect(current.authority.startTriggerRun(input)).rejects.toThrow('Trigger model changed before launch')
        expect(input.onRunCreated).not.toHaveBeenCalled()
        expect(mocks.launched).not.toHaveBeenCalled()
        expect(mocks.release).toHaveBeenCalledOnce()
    })

    it('cancels only the recorded trigger run if model authorization changes after run creation', async () => {
        mocks.fetch.mockImplementationOnce(async () => Response.json({ ok: true, result: { connectionId: model.connectionId, model: model.model } }))
            .mockImplementationOnce(async () => Response.json({ ok: true, result: { connectionId: model.connectionId, model: 'changed-model' } }))
        const current = await runtime(), input = request()

        await expect(current.authority.startTriggerRun(input)).rejects.toThrow('Trigger model changed before launch')
        expect(input.onRunCreated).toHaveBeenCalledWith('run-1', 'session-1')
        expect(mocks.launched).not.toHaveBeenCalled()
        expect(mocks.getRun.mock.calls).toEqual([['engine-1', 'run-1'], ['engine-1', 'run-1']])
        expect(mocks.abortRun).toHaveBeenCalledExactlyOnceWith('run-1')
        expect(mocks.cancelRun).toHaveBeenCalledExactlyOnceWith('engine-1', 'run-1')
        expect(mocks.release).toHaveBeenCalledOnce()
    })
})
