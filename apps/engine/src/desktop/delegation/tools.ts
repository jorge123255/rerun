import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { orderedDelegationResult, type DelegationRuntime } from './runtime.js'
import type { Source } from './types.js'
export const delegationInputSchema = z.object({ tasks: z.array(z.object({ title: z.string().max(200).optional(), task: z.string().min(1).max(32000), context: z.string().max(32000).optional() }).strict()).min(1).max(32) }).strict()
export function desktopDelegationTools(runtime: DelegationRuntime, source: Omit<Source, 'toolCallId'>, signal: AbortSignal): ToolSet {
    return { delegate_tasks: tool({
        description: 'Delegate self-contained tasks to fresh isolated sub-coworkers, up to four at once. Results preserve task order. Children use a permitted subset of this turn’s tools and model, cannot delegate or ask the user, and receive only your explicit task and context. Unsupported tools are unavailable.',
        inputSchema: delegationInputSchema,
        execute: async (input, options) => {
            if (!options.toolCallId) throw new Error('Trusted invocation required')
            const active = AbortSignal.any([signal, ...(options.abortSignal ? [options.abortSignal] : [])])
            return orderedDelegationResult(await runtime.execute({ ...source, toolCallId: options.toolCallId }, input, active))
        },
    }) }
}
