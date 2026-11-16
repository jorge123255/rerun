import type { ChildProcess } from 'node:child_process'

type Runner = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
type SendSignal = (pid: number, signal: NodeJS.Signals | 0) => unknown

export const STOP_RECHECK_INTERVAL_MS = 10_000
export const STOP_RECHECK_ATTEMPTS = 12

const reaped = (child: Runner) => child.exitCode !== null || child.signalCode !== null

/**
 * Whether the runner this app started is gone. A child Node has seen exit is gone (the same test
 * the first stop uses). Otherwise signal 0 asks the system about exactly that process, or exactly
 * the process group a terminal sign-in was started as; only "no such process" confirms it. A
 * refused probe confirms nothing.
 */
export function runnerGone(child: Runner, group: boolean, send: SendSignal = process.kill.bind(process)): boolean {
    if (!child.pid || reaped(child)) return true
    try {
        send(group ? -child.pid : child.pid, 0)
        return false
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
}

/**
 * Sends SIGKILL again to the runner, and to nothing else. While Node has not seen the child exit
 * its process id (and the group named after it) cannot have been given to another program, so the
 * signal cannot land on a stranger; once it has exited, nothing is sent.
 */
export function killRunnerAgain(child: Runner, group: boolean, send: SendSignal = process.kill.bind(process)): void {
    if (!child.pid || reaped(child)) return
    try {
        if (group) send(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
    } catch {
        try { child.kill('SIGKILL') } catch { /* The next check decides. */ }
    }
}

export type StopRecheckOutcome = 'gone' | 'gave-up' | 'superseded'

/**
 * After a stop that could not be confirmed: looks again every ten seconds for two minutes. Each
 * look either finds the runner gone (then `onGone` frees the provider) or kills it again. It never
 * starts anything. `current` turns false when another stop already settled the same runner.
 */
export async function recheckUnconfirmedStop(options: {
    gone: () => boolean
    killAgain: () => void
    current: () => boolean
    onGone: () => void | Promise<void>
    onGiveUp: () => void
    intervalMs?: number
    attempts?: number
    wait?: (ms: number) => Promise<unknown>
}): Promise<StopRecheckOutcome> {
    const intervalMs = options.intervalMs ?? STOP_RECHECK_INTERVAL_MS
    const attempts = options.attempts ?? STOP_RECHECK_ATTEMPTS
    const wait = options.wait ?? (ms => new Promise(resolve => { setTimeout(resolve, ms).unref() }))
    for (let attempt = 0; attempt < attempts; attempt++) {
        await wait(intervalMs)
        if (!options.current()) return 'superseded'
        if (options.gone()) {
            await options.onGone()
            return 'gone'
        }
        options.killAgain()
    }
    // The last kill gets one more interval to land before the provider is left unavailable.
    await wait(intervalMs)
    if (!options.current()) return 'superseded'
    if (options.gone()) {
        await options.onGone()
        return 'gone'
    }
    options.onGiveUp()
    return 'gave-up'
}
