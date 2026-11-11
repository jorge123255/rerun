import { runStepSchema, toolCallSchema } from '@rerun/contracts'
import { z } from 'zod'
import { desktopToolPresentation } from './tool-presentation'

export const desktopRunStepSchema = runStepSchema.pick({
    id: true, stepNumber: true, finishReason: true, totalTokens: true, durationMs: true,
})
export const desktopRunToolSchema = toolCallSchema.pick({
    id: true, stepNumber: true, toolName: true, isError: true, resultJson: true, durationMs: true,
})
export const desktopRunDetailsSchema = z.object({ steps: z.array(desktopRunStepSchema), tools: z.array(desktopRunToolSchema) })
export type DesktopRunDetailsView = z.infer<typeof desktopRunDetailsSchema>
export type DesktopRunToolView = z.infer<typeof desktopRunToolSchema>

export function recordedToolOutcome(tool: DesktopRunToolView) {
    return tool.isError !== 0 ? 'outcomeFailed' : tool.resultJson !== null ? 'outcomeSucceeded' : 'outcomeNotRecorded'
}

// Keep the saved engine telemetry untouched. The local client only receives the bounded
// user-facing result that the conversation would show for this same call.
export function desktopRunDetailsView(steps: unknown, tools: unknown): DesktopRunDetailsView {
    const view = desktopRunDetailsSchema.parse({ steps, tools })
    for (const tool of view.tools) {
        if (tool.resultJson === null) continue
        let output: unknown
        try { output = JSON.parse(tool.resultJson) } catch { output = tool.resultJson }
        const shown = desktopToolPresentation(tool.toolName, undefined, output)
        tool.resultJson = JSON.stringify(shown.errorText ?? shown.output ?? (tool.isError ? 'Tool failed.' : 'Tool completed.'))
    }
    return view
}
