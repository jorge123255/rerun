import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LoadedConnection } from '../../connections/types.js'

const fixture = vi.hoisted(() => ({
    agents: ['unpinned-coworker'],
    runs: [] as { id: string; agentId: string; sessionId: string; status: string }[],
    stopped: [] as string[],
    connections: new Map<string, LoadedConnection>(),
    initialize: async () => {},
    revision: async () => 'rev_fixture-connection',
}))
vi.mock('../../agents/loader.js', () => ({ listAgentIdsOnDisk: async () => fixture.agents }))
vi.mock('../../connections/registry.js', () => ({ findConnection: async (id: string) => {
    if (!fixture.connections.has(id)) fixture.connections.set(id, { id, config: { name: 'Offline fixture', provider: 'openai', models: ['fixture-model'], extraModels: [], createdAt: '2026-11-06T00:00:00.000Z' }, env: {} })
    return fixture.connections.get(id)!
} }))
vi.mock('../../db/repos/runs.js', () => ({ listRunsByAgent: async (id: string) => fixture.runs.filter(run => run.agentId === id) }))
vi.mock('../../runtime/run-control.js', () => ({ abortRun: (id: string) => { fixture.stopped.push(id); return true }, waitForRunCancellation: async () => true }))
vi.mock('./runtime.js', () => ({ initializeDesktopApiConnections: async () => { await fixture.initialize(); return { revision: () => fixture.revision() } } }))
beforeEach(() => { vi.resetModules(); fixture.agents = ['unpinned-coworker']; fixture.runs = []; fixture.stopped = []; fixture.connections = new Map(); fixture.initialize = async () => {}; fixture.revision = async () => 'rev_fixture-connection'; vi.stubEnv('RERUN_DESKTOP_WORKSPACE_ID', '1'); vi.stubEnv('RERUN_DATA_DIR', process.env.TMPDIR!) })
afterEach(() => vi.unstubAllEnvs())

it('keeps unclassified scheduled/default-derived work protected without a chat admission or config pin', async () => {
    fixture.runs = [{ id: 'headless-run', agentId: 'unpinned-coworker', sessionId: 'schedule-chat', status: 'running' }]
    const authority = await import('./run-authority.js')
    const pending = await authority.pendingDesktopApiConnectionRuns('cnx_fixture-target')
    expect(pending).toEqual([{ runId: 'headless-run', sessionId: 'schedule-chat', connectionId: 'cnx_fixture-target', connectionRevision: 'rev_uncaptured', status: 'unknown' }])
    await expect(authority.stopAndDrainDesktopApiConnectionRuns('cnx_fixture-target')).rejects.toThrow('unconfirmed')
    expect(fixture.stopped).toEqual([])
})

it('does not claim a proven sibling connection run belongs to the connection being reviewed', async () => {
    fixture.runs = [{ id: 'sibling-run', agentId: 'unpinned-coworker', sessionId: 'sibling-chat', status: 'running' }]
    const authority = await import('./run-authority.js')
    await authority.admitDesktopApiConnectionRun({ connectionId: 'cnx_fixture-sibling', runId: 'sibling-run', agentId: 'unpinned-coworker', sessionId: 'sibling-chat' })
    expect(await authority.pendingDesktopApiConnectionRuns('cnx_fixture-target')).toEqual([])
    expect((await authority.pendingDesktopApiConnectionRuns('cnx_fixture-sibling'))[0].status).toBe('running')
})

it('refuses truncated running-row coverage rather than declaring removal safe', async () => {
    fixture.runs = Array.from({ length: 50 }, (_, index) => ({ id: `run-${index}`, agentId: 'unpinned-coworker', sessionId: `chat-${index}`, status: 'running' }))
    const authority = await import('./run-authority.js')
    await expect(authority.pendingDesktopApiConnectionRuns('cnx_fixture-target')).rejects.toThrow('too many active runs')
})

it('refuses a stale prepared connection and an unidentified workspace before admitting provider work', async () => {
    const authority = await import('./run-authority.js')
    const input = { connectionId: 'cnx_fixture-target', runId: 'prepared-run', agentId: 'unpinned-coworker', sessionId: 'prepared-chat' }
    const stale: LoadedConnection = { id: input.connectionId, config: { name: 'Offline stale connection', provider: 'openai', models: ['fixture-model'], extraModels: [], createdAt: '2026-11-06T00:00:00.000Z' }, env: {} }
    await expect(authority.admitDesktopApiConnectionRun({ ...input, expectedConnection: stale })).rejects.toThrow('changed during preparation')
    vi.stubEnv('RERUN_DESKTOP_WORKSPACE_ID', '')
    await expect(authority.admitDesktopApiConnectionRun(input)).rejects.toThrow('workspace identity')
})

it.each(['initialization', 'revision'] as const)('refuses a connection replaced while awaiting %s without recording admission', async pause => {
    const authority = await import('./run-authority.js')
    const input = { connectionId: 'cnx_fixture-target', runId: 'prepared-run', agentId: 'unpinned-coworker', sessionId: 'prepared-chat' }
    const prepared: LoadedConnection = { id: input.connectionId, config: { name: 'Offline fixture', provider: 'openai', models: ['fixture-model'], extraModels: [], createdAt: '2026-11-06T00:00:00.000Z' }, env: {} }
    fixture.connections.set(input.connectionId, prepared)
    fixture.runs = [{ id: input.runId, agentId: input.agentId, sessionId: input.sessionId, status: 'running' }]
    let enter!: () => void, resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { resume = resolve })
    if (pause === 'initialization') fixture.initialize = async () => { enter(); await held }
    else fixture.revision = async () => { enter(); await held; return 'rev_replacement-connection' }
    const outcome = authority.admitDesktopApiConnectionRun({ ...input, expectedConnection: prepared })
        .then(release => { release(); return { admitted: true, error: null } }, error => ({ admitted: false, error }))
    await entered
    fixture.connections.set(input.connectionId, { ...prepared, env: { OPENAI_API_KEY: 'offline-replacement-only' } })
    resume()
    const result = await outcome
    expect(result.admitted).toBe(false)
    expect(result.error).toMatchObject({ status: 409, message: expect.stringContaining('changed during preparation') })
    expect((await authority.pendingDesktopApiConnectionRuns(input.connectionId))[0].status).toBe('unknown')
})

it('serializes revision capture with canonical mutation and preserves the admitted generation', async () => {
    const authority = await import('./run-authority.js')
    const { withDesktopApiConnectionMutationLock } = await import('./mutation-lock.js')
    const input = { connectionId: 'cnx_fixture-target', runId: 'prepared-run', agentId: 'unpinned-coworker', sessionId: 'prepared-chat' }
    const prepared: LoadedConnection = { id: input.connectionId, config: { name: 'Offline fixture', provider: 'openai', models: ['fixture-model'], extraModels: [], createdAt: '2026-11-06T00:00:00.000Z' }, env: {} }
    fixture.connections.set(input.connectionId, prepared)
    fixture.runs = [{ id: input.runId, agentId: input.agentId, sessionId: input.sessionId, status: 'running' }]
    let enter!: () => void, resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { resume = resolve })
    fixture.revision = async () => { enter(); await held; return 'rev_fixture-connection' }
    const pending = authority.admitDesktopApiConnectionRun({ ...input, expectedConnection: prepared })
    await entered
    let changed = false
    const mutation = withDesktopApiConnectionMutationLock(1, async () => {
        fixture.connections.set(input.connectionId, { ...prepared, env: { OPENAI_API_KEY: 'offline-next-generation-only' } })
        changed = true
    })
    try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(changed).toBe(false)
    } finally { resume() }
    const release = await pending
    try {
        await mutation
        expect(changed).toBe(true)
        expect((await authority.pendingDesktopApiConnectionRuns(input.connectionId))[0]).toMatchObject({ status: 'running', connectionRevision: 'rev_fixture-connection' })
    } finally { release() }
    expect((await authority.pendingDesktopApiConnectionRuns(input.connectionId))[0].status).toBe('unknown')
})
