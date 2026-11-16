import { APICallError } from 'ai'
import { describe, expect, it } from 'vitest'
import { createStreamRetryMiddleware } from './openrouter-stream-retry.js'
import { createTransientStreamRetryMiddleware, STREAM_STALL_MS, type StreamRetryNotice, type StreamRetryOptions } from './transient-stream-retry.js'

const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const streamStart = { type: 'stream-start', warnings: [] }
const thought = [{ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: 'Let me think' }]
const finish = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
const answer = [streamStart, { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: 'done' }, { type: 'text-end', id: '0' }, finish]
const toolCall = { type: 'tool-call', toolCallId: 'call-1', toolName: 'send_email', input: '{}' }
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
const gateway = (statusCode: number) => new APICallError({ message: 'upstream unavailable', url: 'https://provider.test', requestBodyValues: {}, statusCode, isRetryable: true })

type Attempt = unknown[] | { throws: unknown } | { breaksAfter: unknown[]; error?: unknown } | { hangsAfter: unknown[] }

function streamOf(attempt: Exclude<Attempt, { throws: unknown }>, cancelled: () => void): ReadableStream {
    const parts = Array.isArray(attempt) ? attempt : 'breaksAfter' in attempt ? attempt.breaksAfter : attempt.hangsAfter
    let next = 0
    return new ReadableStream({
        pull(controller) {
            if (next < parts.length) return controller.enqueue(parts[next++])
            if (Array.isArray(attempt)) return controller.close()
            if ('breaksAfter' in attempt) return controller.error(attempt.error ?? reset())
            return new Promise<void>(() => {})
        },
        cancel: cancelled,
    })
}

async function run(attempts: Attempt[], options: Partial<StreamRetryOptions> = {}, abortSignal?: AbortSignal) {
    let calls = 0
    let cancelledStreams = 0
    const notices: StreamRetryNotice[] = []
    const doStream = async () => {
        const attempt = attempts[calls++]
        if (!attempt) throw new Error('no attempt left')
        if (!Array.isArray(attempt) && 'throws' in attempt) throw attempt.throws
        return { stream: streamOf(attempt, () => { cancelledStreams += 1 }) }
    }
    const middleware = createTransientStreamRetryMiddleware({ provider: 'anthropic', delaysMs: [0, 0, 0], notify: notice => notices.push(notice), ...options })
    const parts: any[] = []
    let error: unknown
    try {
        const result = await middleware.wrapStream!({ doStream, params: { abortSignal } } as any)
        for await (const part of result.stream as ReadableStream<any>) parts.push(part)
    } catch (caught) {
        error = caught
    }
    return { parts, calls, notices, error, cancelledStreams }
}

const statuses = (notices: StreamRetryNotice[]) => notices.map(notice => notice.status)

describe('transient stream retry', () => {
    it('passes a healthy stream through untouched and says nothing', async () => {
        const { parts, calls, notices, error } = await run([answer])
        expect(parts).toEqual(answer)
        expect(calls).toBe(1)
        expect(notices).toEqual([])
        expect(error).toBeUndefined()
    })

    it('sends the step again when the stream drops before it did anything', async () => {
        const { parts, calls, notices, error } = await run([{ breaksAfter: [streamStart, ...thought] }, answer])
        expect(error).toBeUndefined()
        expect(calls).toBe(2)
        // The half-open thought is closed, and the replay does not start the stream a second time.
        expect(parts).toEqual([streamStart, ...thought, { type: 'reasoning-end', id: 'r' }, ...answer.slice(1)])
        expect(notices).toEqual([{ status: 'reconnecting', attempt: 1, of: 3 }, { status: 'resumed' }])
    })

    it('sends the step again when the request could not be opened', async () => {
        const { parts, calls, notices } = await run([{ throws: gateway(503) }, { throws: reset() }, answer])
        expect(calls).toBe(3)
        expect(parts).toEqual(answer)
        expect(statuses(notices)).toEqual(['reconnecting', 'reconnecting', 'resumed'])
    })

    it('sends the step again when the provider reports the failure as an error part', async () => {
        const overloaded = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
        const { parts, calls } = await run([[streamStart, overloaded], answer])
        expect(calls).toBe(2)
        expect(parts).toEqual(answer)
    })

    it('never retries once text was shown: the failure leaves as it came', async () => {
        const shown = [streamStart, { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: 'Half an ans' }]
        const { parts, calls, notices, error } = await run([{ breaksAfter: shown }, answer])
        expect(calls).toBe(1)
        expect(parts).toEqual(shown)
        expect((error as { code?: string }).code).toBe('ECONNRESET')
        expect(notices).toEqual([])
    })

    it('never retries once a tool call of the step was started', async () => {
        for (const started of [toolCall, { type: 'tool-input-start', id: 'call-1', toolName: 'send_email' }]) {
            const { calls, error } = await run([{ breaksAfter: [streamStart, started] }, answer])
            expect(calls).toBe(1)
            expect(error).toBeDefined()
        }
        const late = { type: 'error', error: reset() }
        const { parts, calls } = await run([[streamStart, toolCall, late, finish], answer])
        expect(calls).toBe(1)
        expect(parts).toEqual([streamStart, toolCall, late, finish])
    })

    it('never retries sign-in, credits, a spent plan or a policy refusal', async () => {
        for (const error of [
            new APICallError({ message: 'invalid x-api-key', url: 'https://provider.test', requestBodyValues: {}, statusCode: 401 }),
            new Error("You've hit your weekly limit · resets Monday"),
            new Error('You have no credits remaining.'),
            new Error('Blocked by content policy'),
            new APICallError({ message: 'Rate limit reached', url: 'https://provider.test', requestBodyValues: {}, statusCode: 429, isRetryable: true }),
        ]) {
            const opened = await run([{ throws: error }, answer])
            expect(opened.calls).toBe(1)
            // Untouched, so the SDK and the notices treat it exactly as before.
            expect(opened.error).toBe(error)
            const streamed = await run([{ breaksAfter: [streamStart], error }, answer])
            expect(streamed.calls).toBe(1)
            expect(streamed.error).toBe(error)
            expect(streamed.notices).toEqual([])
        }
    })

    it('never retries when the run says no: stopped, settled, or a saved Chief of Staff decision', async () => {
        const { calls, error, notices } = await run([{ breaksAfter: [streamStart] }, answer], { canRetry: () => false })
        expect(calls).toBe(1)
        expect(error).toBeDefined()
        expect(notices).toEqual([])
    })

    it('stops at once when the person stops the run while it is reconnecting', async () => {
        const stop = new AbortController()
        const { calls, error, notices } = await run([{ breaksAfter: [streamStart] }, answer], { delaysMs: [60_000], notify: () => stop.abort(new Error('stopped')) }, stop.signal)
        expect(calls).toBe(1)
        expect(error).toBeDefined()
        expect(notices).toEqual([])
    })

    it('does not retry a stream the person already stopped', async () => {
        const stop = new AbortController()
        stop.abort()
        const { calls } = await run([{ breaksAfter: [streamStart] }, answer], {}, stop.signal)
        expect(calls).toBe(1)
    })

    it('gives up after the last retry and hands the SDK an error it will not retry again', async () => {
        const { calls, error, notices } = await run([{ throws: gateway(503) }, { throws: gateway(503) }, { throws: gateway(503) }, { throws: gateway(503) }, answer])
        expect(calls).toBe(4)
        expect(APICallError.isInstance(error) && error.statusCode).toBe(503)
        expect((error as APICallError).isRetryable).toBe(false)
        expect(statuses(notices)).toEqual(['reconnecting', 'reconnecting', 'reconnecting', 'failed'])
    })

    it('gives up mid-stream after the last retry with the last failure', async () => {
        const cut = { breaksAfter: [streamStart] }
        const { calls, error, notices } = await run([cut, cut, cut, cut, answer])
        expect(calls).toBe(4)
        expect((error as { code?: string }).code).toBe('ECONNRESET')
        expect(statuses(notices).at(-1)).toBe('failed')
    })

    it('starts no retry that would begin past the total cap', async () => {
        const { calls, notices } = await run([{ breaksAfter: [streamStart] }, { breaksAfter: [] }, answer], { delaysMs: [10, 30, 30], totalCapMs: 25 })
        // 10 ms fits under the cap; the next 30 ms wait would not.
        expect(calls).toBe(2)
        expect(statuses(notices)).toEqual(['reconnecting', 'failed'])
    })

    it('treats a stream that goes silent before the step did anything as dropped', async () => {
        const { parts, calls, cancelledStreams, notices } = await run([{ hangsAfter: [streamStart, ...thought] }, answer], { stallMs: 20 })
        expect(calls).toBe(2)
        expect(cancelledStreams).toBe(1)
        expect(parts.at(-1)).toEqual(finish)
        expect(statuses(notices)).toEqual(['reconnecting', 'resumed'])
    })

    // Ten minutes, not five: a model reasoning silently for longer than the timeout is sent, and billed, twice.
    it('waits ten minutes of silence before it calls a stream dropped', () => {
        expect(STREAM_STALL_MS).toBe(10 * 60_000)
    })

    it('does not time a step out once it has shown text, and never without a stall timeout', async () => {
        const stop = new AbortController()
        const shown = [streamStart, { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: 'Thinking it through' }]
        const pending = run([{ hangsAfter: shown }, answer], { stallMs: 10 }, stop.signal)
        const outcome = await Promise.race([pending, new Promise<'still-open'>(resolve => setTimeout(() => resolve('still-open'), 80))])
        expect(outcome).toBe('still-open')
    })
})

describe('the Rerun, OpenRouter and OpenCode replay', () => {
    const noUsage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } }
    const cutFinish = { type: 'finish', finishReason: { unified: 'other', raw: undefined }, usage: noUsage }
    const drain = async (attempts: unknown[][], hooks: Parameters<typeof createStreamRetryMiddleware>[1]) => {
        let calls = 0
        const doStream = async () => ({ stream: new ReadableStream({ start(controller) { for (const part of attempts[calls++] ?? []) controller.enqueue(part); controller.close() } }) })
        const result = await createStreamRetryMiddleware([0, 0], hooks).wrapStream!({ doStream, params: {} } as any)
        for await (const _ of result.stream as ReadableStream<any>) void _
        return calls
    }

    it('tells the run when it reconnects and when the answer is back', async () => {
        const notices: StreamRetryNotice[] = []
        expect(await drain([[streamStart, cutFinish], answer], { notify: notice => notices.push(notice) })).toBe(2)
        expect(notices).toEqual([{ status: 'reconnecting', attempt: 1, of: 2 }, { status: 'resumed' }])
    })

    it('says so when the replays run out, and obeys a run that forbids them', async () => {
        const notices: StreamRetryNotice[] = []
        expect(await drain([[streamStart, cutFinish], [cutFinish], [cutFinish]], { notify: notice => notices.push(notice) })).toBe(3)
        expect(statuses(notices)).toEqual(['reconnecting', 'reconnecting', 'failed'])
        expect(await drain([[streamStart, cutFinish], answer], { canRetry: () => false })).toBe(1)
    })
})

describe('inside a run', () => {
    it('answers after a dropped stream with one step and no error, and never doubles the SDK retries', async () => {
        const { streamText, wrapLanguageModel } = await import('ai')
        const { MockLanguageModelV3 } = await import('ai/test')
        const scripted = (attempts: Attempt[]) => {
            let calls = 0
            const model = new MockLanguageModelV3({
                doStream: async () => {
                    const attempt = attempts[calls++]
                    if (!attempt) throw new Error('no attempt left')
                    if (!Array.isArray(attempt) && 'throws' in attempt) throw attempt.throws
                    return { stream: streamOf(attempt, () => {}) as ReadableStream<any> }
                },
            })
            return { model: wrapLanguageModel({ model, middleware: [createTransientStreamRetryMiddleware({ provider: 'anthropic', delaysMs: [0, 0, 0] })] }), calls: () => calls }
        }

        const dropped = scripted([{ breaksAfter: [streamStart, ...thought] }, answer])
        const errors: unknown[] = []
        const result = streamText({ model: dropped.model, prompt: 'hi', onError: ({ error }) => { errors.push(error) } })
        expect(await result.text).toBe('done')
        expect((await result.steps).length).toBe(1)
        expect(errors).toEqual([])
        expect(dropped.calls()).toBe(2)

        const down = scripted(Array.from({ length: 12 }, () => ({ throws: gateway(503) })))
        const failures: unknown[] = []
        const failed = streamText({ model: down.model, prompt: 'hi', onError: ({ error }) => { failures.push(error) } })
        await failed.consumeStream()
        expect(failures).toHaveLength(1)
        // One first try and three retries of ours; the SDK's own two retries add nothing on top.
        expect(down.calls()).toBe(4)
    })
})
