import { parseHubOutput, redactHistoricalText } from '@rerun/contracts'
import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const link = z.object({
    state: z.literal('needs_owner'), agentId: id, ownerSessionId: id, ownerQuestionId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    coworker: z.string().min(1).max(200).refine(value => !/[\p{Cc}]/u.test(value) && redactHistoricalText(value, 200) === value),
})

// Keep just the public destination of a successful setup inspection. Questions, card inputs and
// credentials from the coworker's conversation belong exclusively to its original controls.
export function ownerSetupLink(output: unknown) {
    if (typeof output === 'string' && output.length > 8000) return null
    const parsed = link.safeParse(parseHubOutput(output))
    return parsed.success ? parsed.data : null
}
