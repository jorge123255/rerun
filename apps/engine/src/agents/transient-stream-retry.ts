import { setTimeout as sleep } from 'node:timers/promises'
import { APICallError, type LanguageModelMiddleware } from 'ai'
import type { Provider } from '@rerun/contracts'
import { ProviderStreamStalledError, transientStreamFailure } from '../runtime/provider-errors.js'

type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>
type StreamResult = Awaited<ReturnType<Parameters<WrapStream>[0]['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

/** What the conversation is told while a step is being sent again. Never carries the error itself. */
export type StreamRetryNotice = { status: 'reconnecting'; attempt: number; of: number } | { status: 'resumed' } | { status: 'failed' }

export type StreamRetryHooks = {
    /** Asked before every retry. The run answers no once it was stopped, settled, or must not repeat a step. */
    canRetry?: () => boolean
    notify?: (notice: StreamRetryNotice) => void
}

export type StreamRetryOptions = StreamRetryHooks & {
    provider: Provider
    delaysMs?: readonly number[]
    /** No retry starts once this much time has passed since the step first failed. */
    totalCapMs?: number
    /** A stream silent for this long, before the step did anything, counts as dropped. Off when undefined. */
    stallMs?: number
}

export const STREAM_RETRY_DELAYS_MS = [2_000, 6_000, 15_000] as const
export const STREAM_RETRY_TOTAL_CAP_MS = 60_000
// Long on purpose: a model that reasons without streaming its thoughts is silent for minutes and is
// not stalled. Ten minutes rather than five (decided November 16, 2026): a model that reasons a long
// time without streaming would otherwise be sent, and billed, twice. Past this, the person would
// otherwise be looking at a run that never ends.
export const STREAM_STALL_MS = 10 * 60_000

// Once one of these has reached the run the step cannot be taken back: the person has read the
// text, or a tool call is on its way to being executed. Reasoning does not count, the chat folds it away.
function commitsTheStep(part: StreamPart): boolean {
    if (part.type === 'text-delta') return part.delta.length > 0
    return part.type === 'tool-input-start' || part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'file' || part.type === 'source'
}

// The SDK retries a retryable API error on its own, and every one of its attempts comes back
// through this middleware. Handing it a copy it will not retry keeps the retries bounded to ours.
function spent(error: unknown): unknown {
    if (!APICallError.isInstance(error) || !error.isRetryable) return error
    return new APICallError({
        message: error.message,
        url: error.url,
        requestBodyValues: error.requestBodyValues,
        statusCode: error.statusCode,
        responseHeaders: error.responseHeaders,
        responseBody: error.responseBody,
        cause: error.cause,
        isRetryable: false,
        data: error.data,
    })
}

/**
 * Sends a step again when its stream failed for a reason that passes (see `transientStreamFailure`)
 * and the step had not yet done anything: no text shown, no tool call started. Partial text is
 * never discarded and replayed; a step that has shown text fails as it did before.
 */
export function createTransientStreamRetryMiddleware(options: StreamRetryOptions): LanguageModelMiddleware {
    const delaysMs = options.delaysMs ?? STREAM_RETRY_DELAYS_MS
    const totalCapMs = options.totalCapMs ?? STREAM_RETRY_TOTAL_CAP_MS
    const notify = (notice: StreamRetryNotice) => {
        try {
            options.notify?.(notice)
        } catch {
            // A closed conversation stream must not fail the step.
        }
    }

    return {
        specificationVersion: 'v3',
        wrapStream: async ({ doStream, params }) => {
            const signal = params.abortSignal
            let retries = 0
            let firstFailureAt: number | undefined
            let announced = false

            const retryable = (error: unknown): boolean => {
                if (signal?.aborted || retries >= delaysMs.length || options.canRetry?.() === false) return false
                if (transientStreamFailure(options.provider, error) === null) return false
                const elapsed = firstFailureAt === undefined ? 0 : Date.now() - firstFailureAt
                return elapsed + delaysMs[retries]! <= totalCapMs
            }
            // Resolves false when the wait was cut short by Stop.
            const backOff = async (): Promise<boolean> => {
                firstFailureAt ??= Date.now()
                const delay = delaysMs[retries]!
                retries += 1
                announced = true
                notify({ status: 'reconnecting', attempt: retries, of: delaysMs.length })
                await sleep(delay, undefined, { signal }).catch(() => {})
                return !signal?.aborted && options.canRetry?.() !== false
            }
            const giveUp = (error: unknown): unknown => {
                if (announced) notify({ status: 'failed' })
                return retries > 0 ? spent(error) : error
            }
            const open = async (): Promise<StreamResult> => {
                for (;;) {
                    try {
                        return await doStream()
                    } catch (error) {
                        if (!retryable(error) || !(await backOff())) throw giveUp(error)
                    }
                }
            }

            const first = await open()
            let reader: ReadableStreamDefaultReader<StreamPart> | undefined
            let cancelled = false

            const stream = new ReadableStream<StreamPart>({
                start(controller) {
                    const openBlocks = new Map<string, 'text-end' | 'reasoning-end'>()
                    let committed = false

                    const read = async (current: ReadableStreamDefaultReader<StreamPart>) => {
                        if (committed || options.stallMs === undefined) return current.read()
                        const stall = new AbortController()
                        const silent = sleep(options.stallMs, 'stalled' as const, { signal: stall.signal, ref: false }).catch(() => 'read' as const)
                        const pending = current.read()
                        const winner = await Promise.race([pending, silent])
                        stall.abort()
                        if (winner !== 'stalled') return pending
                        pending.catch(() => {})
                        throw new ProviderStreamStalledError()
                    }

                    // 'retry' only when the retry is going to happen: every other failure leaves as it came.
                    const forward = async (attempt: ReadableStream<StreamPart>, isReplay: boolean): Promise<{ kind: 'finished' } | { kind: 'retry' } | { kind: 'error'; error: unknown }> => {
                        const current = attempt.getReader()
                        reader = current
                        try {
                            for (;;) {
                                const { done, value } = await read(current)
                                if (done) return { kind: 'finished' }
                                if (value.type === 'error' && !committed && retryable(value.error)) return { kind: 'retry' }
                                if (isReplay && value.type === 'stream-start') continue
                                if (value.type === 'text-start') openBlocks.set(`text:${value.id}`, 'text-end')
                                if (value.type === 'reasoning-start') openBlocks.set(`reasoning:${value.id}`, 'reasoning-end')
                                if (value.type === 'text-end') openBlocks.delete(`text:${value.id}`)
                                if (value.type === 'reasoning-end') openBlocks.delete(`reasoning:${value.id}`)
                                committed ||= commitsTheStep(value)
                                if (announced && value.type !== 'response-metadata') {
                                    announced = false
                                    notify({ status: 'resumed' })
                                }
                                controller.enqueue(value)
                            }
                        } catch (error) {
                            return !committed && retryable(error) ? { kind: 'retry' } : { kind: 'error', error }
                        } finally {
                            reader = undefined
                            // The failed attempt's connection or process is let go before the next one starts.
                            void current.cancel().catch(() => {})
                        }
                    }

                    const closeOpenBlocks = () => {
                        for (const [key, type] of [...openBlocks].reverse()) controller.enqueue({ type, id: key.slice(key.indexOf(':') + 1) } as StreamPart)
                        openBlocks.clear()
                    }

                    const run = async () => {
                        let attempt = first.stream
                        for (let replay = false; ; replay = true) {
                            const end = await forward(attempt, replay)
                            if (cancelled) return
                            if (end.kind === 'finished') return controller.close()
                            if (end.kind === 'error') return controller.error(giveUp(end.error))
                            closeOpenBlocks()
                            if (!(await backOff())) return controller.error(giveUp(signal?.reason ?? new Error('The run was stopped while reconnecting.')))
                            if (cancelled) return
                            try {
                                attempt = (await open()).stream
                            } catch (error) {
                                return controller.error(error)
                            }
                        }
                    }

                    run().catch(error => {
                        if (!cancelled) controller.error(error)
                    })
                },
                cancel(reason) {
                    cancelled = true
                    return reader?.cancel(reason)
                },
            })

            return { ...first, stream }
        },
    }
}
