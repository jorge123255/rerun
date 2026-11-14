import { foremanModelRefSchema, modelContextWindow, usageSchema, type DesktopForemanModelRef, type Run } from '@rerun/contracts'
import { z } from 'zod'
import { contextStatsOf } from '@/lib/chat/context-stats'

export const desktopForemanContextSchema = z.strictObject({
    model: foremanModelRefSchema,
    usage: usageSchema,
    usedTokens: z.number().positive(),
    maxTokens: z.number().positive(),
    estimated: z.boolean(),
})

export function desktopForemanContext(run: Run, model: DesktopForemanModelRef) {
    if (!run.usageJson || !run.provider || run.model !== model.model) return null
    try {
        const usage = usageSchema.parse(JSON.parse(run.usageJson))
        const stats = contextStatsOf([], { usage, provider: run.provider }, run.model)
        if (!stats) return null
        // A custom endpoint can offer an alias whose window differs from the curated model ID.
        const maxTokens = stats.max ?? (run.provider === 'custom' ? undefined : modelContextWindow(run.model, run.provider))
        const estimated = !usage.context
        if (estimated && maxTokens && stats.used > maxTokens) return null
        const result = desktopForemanContextSchema.safeParse({ model, usage, usedTokens: stats.used, maxTokens, estimated })
        return result.success ? result.data : null
    } catch { return null }
}
