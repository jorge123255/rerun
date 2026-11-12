import { z } from 'zod'
import { classifyChatError } from '@rerun/contracts'

export const desktopForemanRunFailureSchema = z.enum([
    'usage_limit', 'unauthorized', 'overloaded', 'context_window', 'provider_error',
    'thinking_replay', 'interrupted', 'generic',
])

export function desktopForemanRunFailure(error: string | null) {
    // Engine errors may include connection details. Only send the classification to the renderer.
    const kind = desktopForemanRunFailureSchema.safeParse(classifyChatError(error ?? ''))
    return kind.success ? kind.data : 'generic' as const
}
