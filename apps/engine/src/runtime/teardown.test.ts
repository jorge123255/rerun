import { expect, it, vi } from 'vitest'
import { closedInTime } from './teardown.js'

it('counts a teardown that resolved in time as closed', async () => {
    expect(await closedInTime(async () => {}, 1_000)).toBe(true)
    expect(await closedInTime(async () => true, 1_000)).toBe(true)
})

it('does not count a rejected teardown as closed', async () => {
    const onTimeout = vi.fn()
    expect(await closedInTime(async () => { throw new Error('app-server close failed') }, 1_000, onTimeout)).toBe(false)
    expect(await closedInTime(() => { throw new Error('threw before returning a promise') }, 1_000, onTimeout)).toBe(false)
    expect(onTimeout).not.toHaveBeenCalled()
})

it('does not count a teardown that reports its own failure as closed', async () => {
    expect(await closedInTime(async () => false, 1_000)).toBe(false)
})

it('does not count a teardown still running at the timeout as closed, and says so once', async () => {
    vi.useFakeTimers()
    try {
        const onTimeout = vi.fn()
        const pending = closedInTime(() => new Promise<void>(() => {}), 15_000, onTimeout)
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await pending).toBe(false)
        expect(onTimeout).toHaveBeenCalledTimes(1)
    } finally {
        vi.useRealTimers()
    }
})
