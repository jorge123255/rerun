import { randomUUID } from 'node:crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Allocation } from './protocol.js'
import type { DelegationClient } from './client.js'

const hooks = vi.hoisted(() => ({ getRun: vi.fn(), closeDb: vi.fn(), inspect: vi.fn(), cleanup: vi.fn(), deletion: vi.fn() }))
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
vi.mock('./resources.js', async importOriginal => ({ ...await importOriginal<typeof import('./resources.js')>(), inspectDelegationDirectory: hooks.inspect, cleanupDelegationDirectory: hooks.cleanup }))
import { createDesktopDelegationHost } from './host.js'

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
