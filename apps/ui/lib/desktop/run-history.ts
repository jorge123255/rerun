import { runSchema, type Run } from '@rerun/contracts'
import { z } from 'zod'

export const desktopRunSchema = runSchema.pick({
    id: true, status: true, startedAt: true, finishedAt: true, stepCount: true,
    provider: true, model: true, inputTokens: true, outputTokens: true,
    cachedInputTokens: true, reasoningTokens: true, totalTokens: true, costMicros: true,
})
export const desktopRunsSchema = z.object({ runs: z.array(desktopRunSchema) })
export type DesktopRunView = z.infer<typeof desktopRunSchema>

const count = z.number().finite().nonnegative()
const usageSchema = z.object({ inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional() })

export function desktopRunView(run: Run): DesktopRunView {
    let usage: z.infer<typeof usageSchema> = {}
    try { usage = usageSchema.parse(JSON.parse(run.usageJson ?? '{}')) } catch {}
    return desktopRunSchema.parse({ ...run,
        inputTokens: run.inputTokens ?? usage.inputTokens ?? null,
        outputTokens: run.outputTokens ?? usage.outputTokens ?? null,
        totalTokens: run.totalTokens ?? usage.totalTokens ?? null,
    })
}

export function recordedRunUsage(run: DesktopRunView): string {
    const total = run.totalTokens ?? (run.inputTokens !== null && run.outputTokens !== null ? run.inputTokens + run.outputTokens : null)
    const parts = [
        total !== null ? `${total.toLocaleString()} tokens` : null,
        run.inputTokens !== null ? `${run.inputTokens.toLocaleString()} input` : null,
        run.outputTokens !== null ? `${run.outputTokens.toLocaleString()} output` : null,
        run.cachedInputTokens !== null ? `${run.cachedInputTokens.toLocaleString()} cached input` : null,
        run.reasoningTokens !== null ? `${run.reasoningTokens.toLocaleString()} reasoning` : null,
        run.costMicros !== null ? `$${(run.costMicros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6 })} recorded cost` : null,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : 'Usage not recorded'
}
