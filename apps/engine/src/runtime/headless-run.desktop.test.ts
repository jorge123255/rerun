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
