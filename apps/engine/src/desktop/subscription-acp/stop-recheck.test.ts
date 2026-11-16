import { describe, expect, it, vi } from 'vitest'
import { killRunnerAgain, recheckUnconfirmedStop, runnerGone, STOP_RECHECK_ATTEMPTS, STOP_RECHECK_INTERVAL_MS } from './stop-recheck.js'

// A runner as the runtime sees it, plus the system's view of which process ids still exist.
function fakeChild(pid = 4242) {
    const child = { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true) }
    const alive = new Set<number>(pid ? [pid, -pid] : [])
    const sent: Array<[number, NodeJS.Signals | 0]> = []
    const send = (target: number, signal: NodeJS.Signals | 0) => {
        sent.push([target, signal])
        if (!alive.has(target)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
        return true
    }
    return { child, alive, sent, send }
}

const errno = (code: string) => () => { throw Object.assign(new Error(code), { code }) }

describe('runnerGone', () => {
    it('probes exactly the process, or exactly its own group, with signal 0', () => {
        const single = fakeChild()
        expect(runnerGone(single.child, false, single.send)).toBe(false)
        expect(single.sent).toEqual([[4242, 0]])
        const group = fakeChild()
        expect(runnerGone(group.child, true, group.send)).toBe(false)
        expect(group.sent).toEqual([[-4242, 0]])
    })

    it('is gone once the system has no such process, or Node saw it exit', () => {
        const vanished = fakeChild()
        vanished.alive.clear()
        expect(runnerGone(vanished.child, false, vanished.send)).toBe(true)
        const exited = fakeChild()
        exited.child.signalCode = 'SIGKILL'
        expect(runnerGone(exited.child, true, exited.send)).toBe(true)
        // An exited child is never probed: its number may already belong to another program.
        expect(exited.sent).toEqual([])
        expect(runnerGone(fakeChild(0).child, false, errno('EPERM'))).toBe(true)
    })

    it('does not take a refused probe for an answer', () => {
        expect(runnerGone(fakeChild().child, true, errno('EPERM'))).toBe(false)
    })
})

describe('killRunnerAgain', () => {
    it('kills the one child, or the one group it leads', () => {
        const single = fakeChild()
        killRunnerAgain(single.child, false, single.send)
        expect(single.child.kill).toHaveBeenCalledWith('SIGKILL')
        expect(single.sent).toEqual([])
        const group = fakeChild()
        killRunnerAgain(group.child, true, group.send)
        expect(group.sent).toEqual([[-4242, 'SIGKILL']])
        expect(group.child.kill).not.toHaveBeenCalled()
    })

    it('falls back to the child when the group signal is refused', () => {
        const { child } = fakeChild()
        killRunnerAgain(child, true, errno('EPERM'))
        expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('sends nothing once the child has exited', () => {
        const { child, send, sent } = fakeChild()
        child.exitCode = 0
        killRunnerAgain(child, true, send)
        killRunnerAgain(child, false, send)
        expect(sent).toEqual([])
        expect(child.kill).not.toHaveBeenCalled()
    })
})

describe('recheckUnconfirmedStop', () => {
    // The provider's slot: occupied until the recheck frees it. `start` is what a new turn would do.
    function slot() {
        const fake = fakeChild()
        const state = { occupied: true, stuck: false, started: 0, waits: [] as number[] }
        const start = () => { if (!state.occupied) state.started += 1 }
        const options = {
            current: () => state.occupied,
            gone: () => runnerGone(fake.child, false, fake.send),
            killAgain: () => killRunnerAgain(fake.child, false, fake.send),
            onGone: () => { state.occupied = false },
            onGiveUp: () => { state.stuck = true },
        }
        return { ...fake, state, start, options }
    }

    it('frees the provider once the old runner is confirmed gone, having killed it again first', async () => {
        const { child, alive, state, start, options } = slot()
        const outcome = await recheckUnconfirmedStop({ ...options, wait: async ms => {
            state.waits.push(ms)
            start()
            // The second SIGKILL lands between the second and third look.
            if (state.waits.length === 3) alive.clear()
        } })
        expect(outcome).toBe('gone')
        expect(state.waits).toEqual([STOP_RECHECK_INTERVAL_MS, STOP_RECHECK_INTERVAL_MS, STOP_RECHECK_INTERVAL_MS])
        expect(child.kill).toHaveBeenCalledTimes(2)
        expect(child.kill).toHaveBeenCalledWith('SIGKILL')
        expect(state).toMatchObject({ occupied: false, stuck: false })
        // Nothing could start while the first runner was unconfirmed.
        expect(state.started).toBe(0)
        start()
        expect(state.started).toBe(1)
    })

    it('leaves the provider unavailable after two minutes of a runner that will not die', async () => {
        const { child, state, start, options } = slot()
        const outcome = await recheckUnconfirmedStop({ ...options, wait: async ms => { state.waits.push(ms); start() } })
        expect(outcome).toBe('gave-up')
        expect(state.waits.slice(0, STOP_RECHECK_ATTEMPTS).reduce((sum, ms) => sum + ms, 0)).toBe(120_000)
        expect(child.kill).toHaveBeenCalledTimes(STOP_RECHECK_ATTEMPTS)
        expect(state).toMatchObject({ occupied: true, stuck: true, started: 0 })
    })

    it('frees the provider when the last kill lands just before the bound', async () => {
        const { alive, state, options } = slot()
        const outcome = await recheckUnconfirmedStop({ ...options, wait: async () => { if (state.waits.push(0) === STOP_RECHECK_ATTEMPTS + 1) alive.clear() } })
        expect(outcome).toBe('gone')
        expect(state).toMatchObject({ occupied: false, stuck: false })
    })

    it('steps aside when another stop already settled the same runner', async () => {
        const { child, state, options } = slot()
        const onGone = vi.fn()
        const outcome = await recheckUnconfirmedStop({ ...options, onGone, wait: async () => { state.occupied = false } })
        expect(outcome).toBe('superseded')
        expect(onGone).not.toHaveBeenCalled()
        expect(child.kill).not.toHaveBeenCalled()
        expect(state.stuck).toBe(false)
    })

    it('waits on a real, unreferenced timer by default', async () => {
        const { alive, state, options } = slot()
        alive.clear()
        expect(await recheckUnconfirmedStop({ ...options, intervalMs: 5, attempts: 2 })).toBe('gone')
        expect(state.occupied).toBe(false)
    })
})
