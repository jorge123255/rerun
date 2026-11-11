import { desktopTemplateIdSchema, desktopTemplateRevisionSchema } from '@rerun/contracts'
import { z } from 'zod'

export const starterChoiceSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), text: z.string().trim().min(1).max(4000) }),
    z.strictObject({ kind: z.literal('cards'), chosen: z.array(z.string().trim().min(1).max(256)).min(1).max(3) }),
    z.strictObject({ kind: z.literal('dismiss') }),
])
export const localStarterDecisionSchema = z.strictObject({
    offerId: z.uuid(),
    intakeRequestId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    choice: starterChoiceSchema,
})
export const desktopStarterViewSchema = localStarterDecisionSchema.omit({ choice: true }).extend({
    cards: z.array(z.strictObject({ templateId: desktopTemplateIdSchema, revision: desktopTemplateRevisionSchema, title: z.string().min(1).max(80) })).min(1).max(24),
    decision: z.strictObject({ choice: starterChoiceSchema, settled: z.boolean() }).nullable(),
})
export type DesktopLocalStarterDecision = z.infer<typeof localStarterDecisionSchema>
export type DesktopStarterView = z.infer<typeof desktopStarterViewSchema>
