import type { LanguageModel } from 'ai'
import type { DesktopSubscriptionProvider } from '@rerun/contracts'
import { openDesktopSubscriptionTurn } from './runtime.js'

type SubscriptionModel = Extract<LanguageModel, { specificationVersion: 'v3' }>
type Call = Parameters<SubscriptionModel['doStream']>[0]
type Result = Awaited<ReturnType<SubscriptionModel['doGenerate']>>
type Stream = Awaited<ReturnType<SubscriptionModel['doStream']>>['stream']
type Part = Stream extends ReadableStream<infer Value> ? Value : never
type Turn = Awaited<ReturnType<Awaited<ReturnType<typeof openDesktopSubscriptionTurn>>['prompt']>>

interface ModelOptions {
    provider: DesktopSubscriptionProvider
    generation: string
    model: string
    reasoning?: string
}

const missingUsage: Result['usage'] = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

function finishReason(reason: Turn['stopReason']): Result['finishReason'] {
    const unified = reason === 'end_turn' ? 'stop' : reason === 'max_tokens' ? 'length'
        : reason === 'refusal' ? 'content-filter' : 'other'
    return { unified, raw: reason }
}

function promptText(prompt: Call['prompt']) {
    const transcript = prompt.flatMap<{ role: string; text: string }>(message => {
        if (message.role === 'system') return [{ role: message.role, text: message.content }]
        if (message.role === 'tool') return []
        if (message.role === 'user' && message.content.some(part => part.type !== 'text')) {
            throw new Error('This subscription provider supports text messages only.')
        }
        const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
        return text ? [{ role: message.role, text }] : []
    })
    return 'Reply to the last user message in this Rerun conversation. ' +
        'Follow system instructions and use earlier messages as conversation history. ' +
        'You can respond with text. You cannot call tools or access files.\n' +
        JSON.stringify(transcript)
}

/** Adapts the approved single-turn text transport to Rerun's existing model stream. */
export function createDesktopSubscriptionModel(options: ModelOptions, open = openDesktopSubscriptionTurn) {
    const lifetime = new AbortController()
    let active: Promise<Turn> | undefined
    const run = (call: Call, cancelled?: AbortSignal, onText?: (text: string) => void) => {
        if (active) throw new Error('The subscription provider connection is already in use.')
        const text = promptText(call.prompt)
        const signal = AbortSignal.any([
            lifetime.signal, ...(call.abortSignal ? [call.abortSignal] : []), ...(cancelled ? [cancelled] : []),
        ])
        signal.throwIfAborted()
        const turn = (async () => {
            const session = await open(options.provider, options.generation, signal)
            return session.prompt({ text, model: options.model, reasoning: options.reasoning, signal, onText })
        })()
        active = turn
        void turn.finally(() => { active = undefined }).catch(() => {})
        return turn
    }

    const model: SubscriptionModel = {
        specificationVersion: 'v3',
        provider: options.provider,
        modelId: options.model,
        supportedUrls: {},
        async doGenerate(call) {
            const turn = await run(call)
            return {
                content: turn.text ? [{ type: 'text', text: turn.text }] : [],
                finishReason: finishReason(turn.stopReason), usage: missingUsage, warnings: [],
            }
        },
        async doStream(call) {
            const cancellation = new AbortController()
            let turn: Promise<Turn>
            const stream = new ReadableStream<Part>({
                start(controller) {
                    let started = false
                    const id = 'reply'
                    controller.enqueue({ type: 'stream-start', warnings: [] })
                    turn = run(call, cancellation.signal, delta => {
                        if (!started) controller.enqueue({ type: 'text-start', id })
                        started = true
                        controller.enqueue({ type: 'text-delta', id, delta })
                    })
                    void turn.then(result => {
                        if (cancellation.signal.aborted) return
                        if (started) controller.enqueue({ type: 'text-end', id })
                        controller.enqueue({ type: 'finish', finishReason: finishReason(result.stopReason), usage: missingUsage })
                        controller.close()
                    }).catch(error => { if (!cancellation.signal.aborted) controller.error(error) })
                },
                async cancel() {
                    cancellation.abort()
                    await turn.catch(() => {})
                },
            })
            return { stream }
        },
    }
    return {
        model,
        async close() {
            lifetime.abort()
            await active?.catch(() => {})
        },
    }
}
