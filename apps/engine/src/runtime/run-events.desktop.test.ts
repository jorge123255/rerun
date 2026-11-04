import { afterEach, expect, it, vi } from 'vitest'

const controls = vi.hoisted(() => ({ desktop: true, write: vi.fn<(...args: unknown[]) => Promise<void>>(), notify: vi.fn() }))
vi.mock('../desktop/policy.js', () => ({ desktopApp: () => controls.desktop }))
vi.mock('../db/completed-runs.js', () => ({ recordRunCompletion: controls.write }))
vi.mock('./notify.js', () => ({ sendNotification: controls.notify }))
import { emitRunTerminal, type RunTerminal } from './run-events.js'

const terminal: RunTerminal = { agentId: 'owner', sessionId: 'chat', runId: 'run', trigger: { source: 'chat' }, kind: 'done', text: 'Actual final answer' }
afterEach(() => { controls.desktop = true; controls.write.mockReset(); controls.notify.mockReset() })

it('does not finish the terminal boundary until its completion write is durable', async () => {
    let release!: () => void
    controls.write.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    controls.notify.mockResolvedValue({ delivered: false })
    let finished = false
    const pending = emitRunTerminal(terminal).then(() => { finished = true })
    try {
        await vi.waitFor(() => expect(controls.write).toHaveBeenCalledOnce())
        expect(finished).toBe(false)
        expect(controls.write).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'owner', sessionId: 'chat', runId: 'run', text: 'Actual final answer' }))
    } finally { release?.() }
    await pending
    expect(finished).toBe(true)
})

it('surfaces a local persistence failure for the settlement logger instead of losing a background rejection', async () => {
    controls.notify.mockResolvedValue({ delivered: false })
    controls.write.mockRejectedValue(new Error('disk unavailable'))
    await expect(emitRunTerminal(terminal)).rejects.toThrow('disk unavailable')
})

it('records a desktop completion even when the unrelated hub notification fails', async () => {
    controls.notify.mockRejectedValue(new Error('hub unavailable'))
    controls.write.mockResolvedValue()
    await emitRunTerminal(terminal)
    expect(controls.write).toHaveBeenCalledOnce()
})

it.each([{ kind: 'error' as const }, { cancelled: true }])('never records an error or stopped run: %j', async patch => {
    controls.notify.mockResolvedValue({ delivered: false })
    await emitRunTerminal({ ...terminal, ...patch })
    expect(controls.write).not.toHaveBeenCalled()
})

it('leaves hosted terminal delivery unchanged and does not create a desktop completion', async () => {
    controls.desktop = false
    controls.notify.mockResolvedValue({ delivered: true })
    await emitRunTerminal(terminal)
    expect(controls.notify).toHaveBeenCalledOnce()
    expect(controls.write).not.toHaveBeenCalled()
})
