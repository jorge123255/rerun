import { z } from 'zod'
import { classifyChatError, describeSubscriptionLimit, foremanModelRefSchema, isAnthropicKeyNotScoped } from '@rerun/contracts'

const failureKind = z.enum([
    'usage_limit', 'unauthorized', 'overloaded', 'context_window', 'provider_error',
    'thinking_replay', 'interrupted', 'generic',
])
// The two Anthropic API key failures the notice explains in their own words (upstream #250). A
// closed name rather than the provider's sentence, so the renderer still receives no error text.
const failureDetail = z.enum(['anthropic_credits', 'anthropic_key_not_scoped'])
export type DesktopForemanRunFailureDetail = z.infer<typeof failureDetail>
export const desktopForemanRunFailureSchema = z.strictObject({
    kind: failureKind,
    connectionId: foremanModelRefSchema.shape.connectionId,
    detail: failureDetail.optional(),
})

// Fixed sentences the shared chat copy reads the same way as the provider's own: what the notice is
// handed in place of the stored error.
const DETAIL_TEXT: Record<DesktopForemanRunFailureDetail, string> = {
    anthropic_credits: 'Your credit balance is too low to access the Anthropic API.',
    anthropic_key_not_scoped: 'This API key is not scoped to a workspace.',
}
export const desktopForemanRunFailureText = (detail: DesktopForemanRunFailureDetail | undefined): string | undefined => detail ? DETAIL_TEXT[detail] : undefined

function detailOf(kind: z.infer<typeof failureKind>, error: string): DesktopForemanRunFailureDetail | undefined {
    if (kind === 'usage_limit' && describeSubscriptionLimit(error).plan === 'anthropic') return 'anthropic_credits'
    if (isAnthropicKeyNotScoped(kind, error)) return 'anthropic_key_not_scoped'
    return undefined
}

export function desktopForemanRunFailure(error: string | null, connectionId: string) {
    // The renderer receives a category and the admitted connection ID, never provider error text.
    const parsed = failureKind.safeParse(classifyChatError(error ?? ''))
    const kind = parsed.success ? parsed.data : 'generic' as const
    const detail = detailOf(kind, error ?? '')
    return detail ? { kind, connectionId, detail } : { kind, connectionId }
}
