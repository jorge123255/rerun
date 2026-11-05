import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readCoworkerSkillBody, SKILL_BODY_TIMEOUT_MS } from './coworker-skill-body'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
function request(signal: AbortSignal, read: () => Promise<ReadableStreamReadResult<Uint8Array>>, cancel: () => Promise<void>) {
    return { signal, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) } } as unknown as Request
}

test.each(['abort', 'deadline'] as const)('a stalled body is bounded by %s even when cleanup never settles', async reason => {
    const stop = new AbortController(), late = deferred<ReadableStreamReadResult<Uint8Array>>()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const result = readCoworkerSkillBody(request(stop.signal, () => late.promise, cancel), 100).catch(error => error)
    if (reason === 'abort') stop.abort()
    else await vi.advanceTimersByTimeAsync(SKILL_BODY_TIMEOUT_MS)
    expect(await result).toMatchObject({ status: reason === 'abort' ? 499 : 408 })
    expect(cancel).toHaveBeenCalledTimes(1)
    late.reject(new Error('Late read failure'))
    await Promise.resolve()
})

test('counts actual streamed bytes even when Content-Length claims a smaller request', async () => {
    const stop = new AbortController(), cancel = vi.fn(async () => {})
    const input = request(stop.signal, async () => ({ done: false, value: new Uint8Array(101) }), cancel)
    input.headers.set('content-length', '1')
    await expect(readCoworkerSkillBody(input, 100)).rejects.toMatchObject({ status: 413 })
    expect(cancel).toHaveBeenCalledTimes(1)
})

test('rejects malformed JSON and accepts a complete bounded document', async () => {
    const input = (body: string) => new Request('http://local/skills', { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    await expect(readCoworkerSkillBody(input('{broken'), 100)).rejects.toMatchObject({ status: 400 })
    expect(await readCoworkerSkillBody(input('{"decision":"accept"}'), 100)).toEqual({ decision: 'accept' })
})
