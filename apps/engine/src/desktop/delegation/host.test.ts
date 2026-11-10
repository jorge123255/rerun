import { randomUUID } from 'node:crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import { sourceSchema, type Allocation } from './protocol.js'
import type { DelegationStore, Record as DelegationRecord, ReceiptStore } from './types.js'
import { createDelegationRuntime } from './runtime.js'
import type { DelegationClient } from './client.js'

const hooks = vi.hoisted(() => ({ getRun: vi.fn(), closeDb: vi.fn(), inspect: vi.fn(), cleanup: vi.fn(), deletion: vi.fn(), allocate: vi.fn(), initialize: vi.fn() }))
vi.mock('../../agents/availability.js', () => ({ isUsable: vi.fn() }))
vi.mock('../../connections/registry.js', () => ({ findConnection: vi.fn() }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: hooks.getRun, cancelRun: vi.fn() }))
vi.mock('../../db/repos/sessions.js', () => ({ createSession: vi.fn(), getSession: vi.fn() }))
vi.mock('../../runtime/headless-run.js', () => ({ startHeadlessRun: vi.fn() }))
vi.mock('../../runtime/run-control.js', () => ({ abortRun: vi.fn(), sessionClaim: vi.fn(), waitForRunCancellation: vi.fn() }))
vi.mock('../../db/systemDb.js', () => ({ closeSystemDb: hooks.closeDb }))
vi.mock('../../db/agentDb.js', () => ({ closeAgentDb: hooks.closeDb }))
vi.mock('../../agents/registry.js', () => ({ unloadAgent: vi.fn() }))
vi.mock('../../agents/codex-threads.js', () => ({ forgetCodexThread: vi.fn() }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: vi.fn() }))
vi.mock('../agent-lifecycle.js', () => ({ desktopDeletionActive: vi.fn(), persistDesktopAgentDeletion: hooks.deletion, withDesktopAgentDeletion: async (_id: string, work: () => Promise<void>) => work() }))
vi.mock('../coworker-calls/prepare.js', () => ({ redactCoworkerCallText: (text: string) => text }))
vi.mock('../../tools/builtin/sub-run-watch.js', () => ({ isFailureResult: vi.fn() }))
vi.mock('./child-scope.js', () => ({ registerDelegationChild: vi.fn() }))
vi.mock('./resources.js', async importOriginal => ({ ...await importOriginal<typeof import('./resources.js')>(), inspectDelegationDirectory: hooks.inspect, cleanupDelegationDirectory: hooks.cleanup, allocateDelegationDirectory: hooks.allocate, initializeDelegationDirectory: hooks.initialize }))
import { createDesktopDelegationHost } from './host.js'
import { agentConfigSchema } from '@rerun/contracts'
import { isUsable } from '../../agents/availability.js'
import { findConnection } from '../../connections/registry.js'
import { createSession } from '../../db/repos/sessions.js'
import { readAgentConfig } from '../../agents/loader.js'
import { startHeadlessRun } from '../../runtime/headless-run.js'
import { sessionClaim, waitForRunCancellation } from '../../runtime/run-control.js'
import type { RunContext } from '../../runtime/context.js'
import { registerDelegationChild } from './child-scope.js'

beforeEach(() => { vi.clearAllMocks(); hooks.cleanup.mockResolvedValue(undefined); hooks.deletion.mockResolvedValue(undefined) })
function fixture(input: Partial<Allocation> = {}) {
    let row: Allocation = { token: randomUUID(), identity: randomUUID(), revision: randomUUID(), epoch: 'old-launch', source: { parentAgentId: 'coworker', parentSessionId: 'chat', parentRunId: 'run', toolCallId: 'tool' }, taskId: randomUUID(), childAgentId: `delegate-${randomUUID()}`, rootIdentity: '1:2', sessionId: 'child-session', runId: 'child-run', phase: 'drained', manifest: [], ...input }
    const save = vi.fn(async (next: Allocation, revision: string) => {
        if (row.revision !== revision) throw new Error('stale fixture write')
        row = structuredClone(next); return structuredClone(row)
    })
    const client = { resource: async () => structuredClone(row), saveResource: save } as unknown as DelegationClient
    const { host } = createDesktopDelegationHost(client, 'new-launch')
    return { host, save, read: () => row, resource: { token: row.token, identity: row.identity } }
}
const signal = () => new AbortController().signal

test.each(['drained', 'retired'] as const)('restart does not reopen a %s child database or cancel a replacement run', async phase => {
    const { host, resource, save } = fixture({ phase })
    await host.drain(resource, signal())
    expect(hooks.getRun).not.toHaveBeenCalled(); expect(hooks.closeDb).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
})

test('a missing creation manifest cannot adopt directory contents at output admission', async () => {
    const { host, resource, save, read } = fixture({ manifest: null })
    hooks.inspect.mockResolvedValue([{ path: 'config.json', dev: '1', ino: '22', size: 2, directory: false, hash: 'a'.repeat(64) }])
    await expect(host.admitOutputs(resource, read().source, read().taskId, signal())).rejects.toThrow('preserved')
    expect(save).not.toHaveBeenCalled()
})

test('durable cleanup intent precedes filesystem cleanup and a lost acknowledgement retries the same resource', async () => {
    const { host, resource, read } = fixture()
    hooks.cleanup.mockImplementationOnce(async (record: Allocation) => {
        expect(record.cleanupStarted).toBe(true)
        expect(read().cleanupStarted).toBe(true)
        throw new Error('restart after directory deletion')
    })
    await expect(host.cleanup(resource, [], signal())).rejects.toThrow('restart')
    expect(read().phase).toBe('drained')
    const restarted = fixture(structuredClone(read()))
    await restarted.host.admitOutputs(restarted.resource, read().source, read().taskId, signal())
    expect(hooks.inspect).not.toHaveBeenCalled()
    await restarted.host.cleanup(restarted.resource, [], signal())
    expect(restarted.read().phase).toBe('retired')
    expect(hooks.cleanup).toHaveBeenCalledTimes(2)
    expect(hooks.deletion).toHaveBeenCalledWith(read().childAgentId)
})

test('an unadmitted resource never reaches filesystem cleanup', async () => {
    const { host, resource } = fixture({ phase: 'running' })
    await expect(host.cleanup(resource, [], signal())).rejects.toThrow('not admitted')
    expect(hooks.cleanup).not.toHaveBeenCalled()
})


test('queued recovery projects a full snapshot through the strict bridge and completes without any allocated resource', async () => {
    let record: DelegationRecord = {
        version: 1, digest: 'queued-fixture', resources: [null], outputs: [null],
        snapshot: {
            parentAgentId: 'owner', parentSessionId: 'chat', parentRunId: 'parent-run', toolCallId: 'delegate-tool',
            delegationId: randomUUID(), revision: randomUUID(),
            tasks: [{ taskId: randomUUID(), stopRevision: randomUUID(), title: 'Never launched', status: 'queued', steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [], cleanup: 'pending' }],
        },
    }
    const snapshot = structuredClone(record.snapshot)
    expect(() => sourceSchema.parse(snapshot)).toThrow()
    const request = vi.fn(async (operation: string, input: { source: unknown; taskId: string }) => {
        expect(operation).toBe('recover')
        expect(sourceSchema.parse(input.source)).toEqual({ parentAgentId: 'owner', parentSessionId: 'chat', parentRunId: 'parent-run', toolCallId: 'delegate-tool' })
        expect(input.taskId).toBe(snapshot.tasks[0]!.taskId)
        return null
    })
    const { host } = createDesktopDelegationHost({ request } as unknown as DelegationClient, 'new-launch')
    await expect(host.recover(snapshot, snapshot.tasks[0]!.taskId)).resolves.toBeNull()
    request.mockClear()
    const store: DelegationStore = {
        reserve: async () => { throw new Error('Recovery must not allocate work') },
        save: async (next, expectedRevision) => {
            if (record.snapshot.revision !== expectedRevision) throw new Error('Fixture revision conflict')
            record = structuredClone(next)
        },
        read: async id => id === record.snapshot.delegationId ? structuredClone(record) : null,
        list: async () => [structuredClone(record)],
    }
    const receipts: ReceiptStore = { read: async () => null, reserve: async (_id, receipt) => receipt, put: async () => {} }
    const runtime = createDelegationRuntime(store, host, receipts)
    await runtime.reconcile()
    expect(request).toHaveBeenCalledTimes(1)
    expect(record.snapshot.tasks[0]).toMatchObject({ cleanup: 'complete', status: 'error' })
    expect(record.snapshot.tasks[0]!.startedAt).toBeUndefined()
    expect(record.resources).toEqual([null])
    expect(hooks.getRun).not.toHaveBeenCalled()
    expect(hooks.closeDb).not.toHaveBeenCalled()
    expect(hooks.inspect).not.toHaveBeenCalled()
    expect(hooks.cleanup).not.toHaveBeenCalled()
})

test('a delegated sub-run is a chat task and is not marked called by a coworker', async () => {
    const source = { parentAgentId: 'coworker', parentSessionId: 'chat', parentRunId: 'parent-run', toolCallId: 'tool' }
    let row: Allocation = {
        token: randomUUID(), identity: randomUUID(), revision: randomUUID(), epoch: 'launch-epoch', source, taskId: randomUUID(),
        childAgentId: `delegate-${randomUUID()}`, rootIdentity: null, sessionId: null, runId: null, phase: 'reserved', manifest: null,
    }
    const save = vi.fn(async (next: Allocation, revision: string) => {
        if (row.revision !== revision) throw new Error('stale fixture write')
        row = structuredClone(next)
        return structuredClone(row)
    })
    const client = {
        request: async (operation: string) => { if (operation !== 'allocate') throw new Error(operation); return structuredClone(row) },
        resource: async (token: string) => { if (token !== row.token) throw new Error('token'); return structuredClone(row) },
        saveResource: save,
        authority: async () => ({ source, webFetch: false }),
    } as unknown as DelegationClient
    const parentConfig = agentConfigSchema.parse({ name: 'Ann', enabled: true, tools: { desktopToolGrants: { delegate: true } } })
    vi.mocked(readAgentConfig).mockResolvedValue(parentConfig)
    vi.mocked(sessionClaim).mockReturnValue({ runId: 'parent-run' } as never)
    hooks.getRun.mockResolvedValue({ agentId: 'coworker', sessionId: 'chat', status: 'running' })
    vi.mocked(findConnection).mockResolvedValue({ config: { provider: 'openai' } } as never)
    vi.mocked(isUsable).mockReturnValue(true)
    hooks.allocate.mockResolvedValue('9:9')
    hooks.initialize.mockImplementation(async (_record: Allocation, _config: unknown, check: () => Promise<void>, persist: (manifest: Allocation['manifest']) => Promise<void>) => {
        await check()
        await persist([])
    })
    hooks.inspect.mockResolvedValue([])
    vi.mocked(createSession).mockResolvedValue({ id: 'child-session' } as never)
    vi.mocked(registerDelegationChild).mockReturnValue({ runCreated: () => undefined, close: () => undefined })
    vi.mocked(waitForRunCancellation).mockResolvedValue(true)
    vi.mocked(startHeadlessRun).mockImplementation(async (_agent, _session, _message, _override, _trigger, lifecycle) => {
        await lifecycle?.beforeLaunch?.()
        await lifecycle?.onRunCreated?.('child-run')
        await lifecycle?.assertActive?.()
        return { runId: 'child-run', result: { fullStream: (async function* () {})() }, settled: Promise.resolve({ kind: 'done' }) } as never
    })
    const { host, register } = createDesktopDelegationHost(client, 'launch-epoch')
    const ctx = {
        runId: 'parent-run', abortSignal: new AbortController().signal, sessionId: 'chat', model: 'm', provider: 'openai',
        agent: { id: 'coworker', config: parentConfig, resolved: { connection: { id: 'conn' } } },
    } as RunContext
    register(source, ctx)
    const resource = await host.allocate(source, row.taskId)
    const child = await host.create(resource, { task: 'Answer from what you hold', connectionId: 'conn', model: 'm', tools: [], authorizeTool: async () => undefined, signal: new AbortController().signal })
    await expect(child.run(async () => undefined)).resolves.toBe('')
    expect(vi.mocked(startHeadlessRun)).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.childAgentId, config: expect.objectContaining({ ephemeral: true }) }),
        'child-session',
        'Answer from what you hold',
        expect.objectContaining({ connectionId: 'conn', provider: 'openai', model: 'm' }),
        { source: 'chat' },
        expect.any(Object),
    )
    expect(vi.mocked(startHeadlessRun).mock.calls[0][4]).not.toHaveProperty('calledBy')
})
