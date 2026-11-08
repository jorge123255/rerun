import type { LanguageModelMiddleware } from 'ai'
import { chunkReasoningDelta } from '../../agents/openrouter-reasoning.js'
import { desktopOpencodeCacheWrite, desktopOpencodeCost, findDesktopOpencodeUsage, type DesktopOpencodeUsage } from './wire.js'

// `REASONING_ID` and `closesReasoning` are not exported from openrouter-reasoning.ts on this base.
// The predicates match that file. This middleware does not add OpenRouter's reasoning request fields.
const REASONING_ID = 'reasoning-0'

function closesReasoning(part: { type: string; delta?: unknown }): boolean {
    if (part.type === 'text-delta') return typeof part.delta === 'string' && part.delta.length > 0
    return part.type === 'tool-input-start' || part.type === 'tool-call' || part.type === 'finish'
}

type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>
type StreamResult = Awaited<ReturnType<Parameters<WrapStream>[0]['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
type FinishPart = Extract<StreamPart, { type: 'finish' }>

function withOpencodeUsage(part: FinishPart, usage: DesktopOpencodeUsage): FinishPart {
    const cost = desktopOpencodeCost(usage)
    const cacheWrite = desktopOpencodeCacheWrite(usage)
    const current = part.usage as FinishPart['usage'] & {
        inputTokens?: { cacheWrite?: number }
        inputTokenDetails?: { cacheWriteTokens?: number }
    }
    const next = { ...current }
    if (cacheWrite !== undefined && next.inputTokens && !next.inputTokens.cacheWrite) next.inputTokens = { ...next.inputTokens, cacheWrite }
    if (cacheWrite !== undefined && next.inputTokenDetails && next.inputTokenDetails.cacheWriteTokens === undefined) {
        next.inputTokenDetails = { ...next.inputTokenDetails, cacheWriteTokens: cacheWrite }
    }
    return { ...part, usage: next, providerMetadata: cost ? { ...part.providerMetadata, opencode: cost } : part.providerMetadata }
}

// Stream only. One-shot compaction, curator, and vision record no cost of their own.
export const desktopOpencodeUsageMiddleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
    wrapStream: async ({ doStream }) => {
        const result = await doStream()
        let usage: DesktopOpencodeUsage | undefined
        return {
            ...result,
            stream: result.stream.pipeThrough(new TransformStream<StreamPart, StreamPart>({
                transform(part, controller) {
                    if (part.type === 'raw') usage = findDesktopOpencodeUsage(part.rawValue) ?? usage
                    controller.enqueue(part.type === 'finish' && usage ? withOpencodeUsage(part, usage) : part)
                },
            })),
        }
    },
}

// Chat completions hide reasoning in delta.reasoning_content. The OpenAI SDK drops that field.
export const desktopOpencodeChatReasoningMiddleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
    wrapStream: async ({ doStream }) => {
        const result = await doStream()
        let open = false
        return {
            ...result,
            stream: result.stream.pipeThrough(new TransformStream<StreamPart, StreamPart>({
                transform(part, controller) {
                    if (part.type === 'raw') {
                        const delta = chunkReasoningDelta(part.rawValue)
                        if (delta) {
                            if (!open) controller.enqueue({ type: 'reasoning-start', id: REASONING_ID } as StreamPart)
                            open = true
                            controller.enqueue({ type: 'reasoning-delta', id: REASONING_ID, delta } as StreamPart)
                        }
                    } else if (open && closesReasoning(part as { type: string; delta?: unknown })) {
                        controller.enqueue({ type: 'reasoning-end', id: REASONING_ID } as StreamPart)
                        open = false
                    }
                    controller.enqueue(part)
                },
                flush(controller) {
                    if (open) controller.enqueue({ type: 'reasoning-end', id: REASONING_ID } as StreamPart)
                },
            })),
        }
    },
}
