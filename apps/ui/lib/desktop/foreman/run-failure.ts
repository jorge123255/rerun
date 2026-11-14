import { z } from 'zod'
import { classifyChatError, foremanModelRefSchema } from '@rerun/contracts'

const failureKind = z.enum([
    'usage_limit', 'unauthorized', 'overloaded', 'context_window', 'provider_error',
    'thinking_replay', 'interrupted', 'generic',
])
export const desktopForemanRunFailureSchema = z.strictObject({
    kind: failureKind,
    connectionId: foremanModelRefSchema.shape.connectionId,
})

export function desktopForemanRunFailure(error: string | null, connectionId: string) {
    // The renderer receives a category and the admitted connection ID, never provider error text.
    const kind = failureKind.safeParse(classifyChatError(error ?? ''))
    return { kind: kind.success ? kind.data : 'generic' as const, connectionId }
}
