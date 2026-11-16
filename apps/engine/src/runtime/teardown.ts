/**
 * Whether a run's provider was confirmed down within the time allowed. Only a teardown that
 * resolved, and did not report a failure of its own, counts: one that rejected, answered `false`,
 * or is still going when the timer fires leaves the process possibly up. The caller treats all
 * three alike (a Codex app-server that may still hold its thread's writer lock is not resumed).
 */
export async function closedInTime(close: () => Promise<boolean | void>, timeoutMs: number, onTimeout: () => void = () => {}): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<false>(resolve => {
        timer = setTimeout(() => {
            onTimeout()
            resolve(false)
        }, timeoutMs)
    })
    try {
        return await Promise.race([Promise.resolve().then(close).then(closed => closed !== false, () => false), guard])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
