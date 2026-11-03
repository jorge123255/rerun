import { runStepSchema, toolCallSchema } from '@rerun/contracts'
import { z } from 'zod'

export const desktopRunStepSchema = runStepSchema.pick({
    id: true, stepNumber: true, finishReason: true, totalTokens: true, durationMs: true,
})
export const desktopRunToolSchema = toolCallSchema.pick({
    id: true, stepNumber: true, toolName: true, isError: true, resultJson: true, durationMs: true,
})
export const desktopRunDetailsSchema = z.object({ steps: z.array(desktopRunStepSchema), tools: z.array(desktopRunToolSchema) })
export type DesktopRunDetailsView = z.infer<typeof desktopRunDetailsSchema>
export type DesktopRunToolView = z.infer<typeof desktopRunToolSchema>

export function recordedToolOutcome(tool: DesktopRunToolView): string {
    return tool.isError !== 0 ? 'Failed' : tool.resultJson !== null ? 'Succeeded' : 'Outcome not recorded'
}
