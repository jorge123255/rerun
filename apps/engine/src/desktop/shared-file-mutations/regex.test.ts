import { expect, test } from 'vitest'
import { sharedRegexLines } from './regex.js'

test('regex results are bounded and a pathological pattern is terminated off the event loop', async () => {
    expect(await sharedRegexLines(['one','two','one'],'one',1)).toEqual([0])
    let responsive = false
    const tick = setTimeout(() => { responsive = true },10)
    try { await expect(sharedRegexLines([`${'a'.repeat(3500)}!`],'^(a+)+$',10)).rejects.toThrow('time limit') }
    finally { clearTimeout(tick) }
    expect(responsive).toBe(true)
})
test('Stop cancels an in-flight pathological regex without waiting for the pattern', async () => {
    const stop = new AbortController()
    const result = sharedRegexLines([`${'a'.repeat(3500)}!`],'^(a+)+$',10,stop.signal)
    stop.abort(new Error('stopped'))
    await expect(result).rejects.toThrow('stopped')
})
