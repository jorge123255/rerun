import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ start: vi.fn(), context: vi.fn(), cancel: vi.fn(), run: vi.fn(), merge: vi.fn() }))
vi.mock('../desktop/policy.js', () => ({ desktopApp: () => true }))
vi.mock('../db/repos/runs.js', () => ({ startRun: mocks.start, setRunContext: mocks.context, cancelRun: mocks.cancel }))
vi.mock('./loop.js', () => ({ runAgent: mocks.run }))
vi.mock('./run-stream-merge.js', () => ({ mergeRunStream: mocks.merge }))
vi.mock('./stream.js', () => ({ registerRun: (_id: string, run: (writer: unknown) => Promise<void>) => { void run({}).catch(() => {}); return { body: {} } } }))
import { startHeadlessRun } from './headless-run.js'
const agent = { id: 'owner', resolved: { provider: 'codex', model: 'terra' } } as never
const trigger = { source: 'schedule', slug: 'daily', name: 'Daily' } as const
beforeEach(() => { vi.clearAllMocks(); mocks.start.mockResolvedValue({ id: 'run' }); mocks.context.mockResolvedValue(undefined); mocks.cancel.mockResolvedValue(undefined); mocks.run.mockResolvedValue({ runId: 'run' }) })

test('persists exact schedule context before launch callbacks and an early provider failure', async () => {
    const order: string[] = []
    mocks.context.mockImplementationOnce(async () => { order.push('context') })
    mocks.run.mockImplementationOnce(async () => { order.push('provider'); throw new Error('No model available') })
    let before = 0
    await expect(startHeadlessRun(agent, 'session', 'Read notes', undefined, trigger, { beforeLaunch: async () => { if (++before > 1) order.push('admission') } })).rejects.toThrow('No model available')
    expect(mocks.context).toHaveBeenCalledWith('owner', 'run', { provider: 'codex', model: 'terra', triggerSource: 'schedule', triggerSlug: 'daily' })
    expect(order).toEqual(['context', 'admission', 'admission', 'provider'])
})

test('a failed durable context write cancels the reserved run without model launch', async () => {
    mocks.context.mockRejectedValueOnce(new Error('Database unavailable'))
    await expect(startHeadlessRun(agent, 'session', 'Read notes', undefined, trigger)).rejects.toThrow('Database unavailable')
    expect(mocks.cancel).toHaveBeenCalledWith('owner', 'run')
    expect(mocks.run).not.toHaveBeenCalled()
})

test('awaits the durable run-created hook before provider work', async () => {
    let release!: () => void
    let recorded!: () => void
    const reached = new Promise<void>(resolve => { recorded = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    const work = startHeadlessRun(agent, 'session', 'Call Bob', undefined, { source: 'chat' }, {
        beforeLaunch: async () => undefined,
        onRunCreated: async id => { expect(id).toBe('run'); recorded(); await pending },
    })
    await reached
    expect(mocks.run).not.toHaveBeenCalled()
    release()
    await work
    expect(mocks.run).toHaveBeenCalledOnce()
})

test('a lost run-created acknowledgement cancels the exact reserved run without launching', async () => {
    await expect(startHeadlessRun(agent, 'session', 'Call Bob', undefined, { source: 'chat' }, {
        beforeLaunch: async () => undefined,
        onRunCreated: async () => { throw new Error('Lineage acknowledgement lost') },
    })).rejects.toThrow('Lineage acknowledgement lost')
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('owner', 'run')
    expect(mocks.run).not.toHaveBeenCalled()
})

test('awaits an asynchronous final assertion instead of orphaning its rejection', async () => {
    let checks = 0
    await expect(startHeadlessRun(agent, 'session', 'Call Bob', undefined, { source: 'chat' }, {
        beforeLaunch: async () => undefined,
        assertActive: async () => { await Promise.resolve(); if (++checks === 2) throw new Error('Permission changed') },
    })).rejects.toThrow('Permission changed')
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('owner', 'run')
    expect(mocks.run).not.toHaveBeenCalled()
})

test('rejects the pending start when the last admission and cancellation write both fail', async () => {
    let checks = 0
    mocks.cancel.mockRejectedValueOnce(new Error('Cancellation write failed'))
    await expect(startHeadlessRun(agent, 'session', 'Call Bob', undefined, { source: 'chat' }, {
        beforeLaunch: async () => { if (++checks === 3) throw new Error('Permission changed') },
    })).rejects.toThrow('Cancellation write failed')
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('owner', 'run')
    expect(mocks.run).not.toHaveBeenCalled()
})
