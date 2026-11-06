import { ZodError } from 'zod'
import { DESKTOP_TRIGGER_TOOL_MESSAGES as M } from '@rerun/contracts'
import { DesktopTriggerLifecycleError } from '../triggers/lifecycle.js'

export class DesktopTriggerToolError extends Error {
    readonly outcome: 'rejected' | 'cancelled' | 'uncertain'
    constructor(outcome: 'rejected' | 'cancelled' | 'uncertain', message: string) {
        super(message)
        this.name = 'DesktopTriggerToolError'
        this.outcome = outcome
    }
}

/** Map lifecycle failures onto model text. Unknown failures stay uncertain and do not include paths or secrets. */
export function mapTriggerToolError(error: unknown, slug: string | null): { outcome: 'rejected' | 'cancelled' | 'uncertain'; message: string } {
    if (error instanceof DesktopTriggerToolError) return { outcome: error.outcome, message: error.message }
    if (error instanceof ZodError) return { outcome: 'rejected', message: M.rejectedInput }
    if (error instanceof DesktopTriggerLifecycleError) {
        switch (error.message) {
            case 'Trigger not found':
            case 'Invalid trigger':
                return { outcome: 'rejected', message: slug ? M.notFound(slug) : M.rejectedInput }
            case 'Coworker triggers revoked':
                return { outcome: 'rejected', message: M.revoked }
            case 'Trigger changed since you opened it':
                return { outcome: 'rejected', message: M.stale }
            case 'A trigger with this name already exists':
                return { outcome: 'rejected', message: M.exists }
            case 'This request belongs to a different trigger change':
                return { outcome: 'rejected', message: M.conflict }
            case 'This earlier change was interrupted. Reopen the trigger and make a new change.':
                return { outcome: 'rejected', message: M.interrupted }
            case 'Another trigger change is awaiting acknowledgement. Retry that change first.':
                return { outcome: 'rejected', message: M.pending }
            case 'Trigger was replaced while its change was pending':
                return { outcome: 'rejected', message: M.replaced }
            case 'Trigger change was not acknowledged. Retry the same change.':
                return { outcome: 'uncertain', message: M.uncertain }
            case 'Coworker identity changed':
                return { outcome: 'rejected', message: M.deleting }
            case 'Enable this coworker to manage triggers':
                return { outcome: 'rejected', message: M.disabled }
            case 'Trigger name must contain a letter or digit':
                return { outcome: 'rejected', message: M.name }
            default:
                return { outcome: 'uncertain', message: M.uncertain }
        }
    }
    if (error instanceof Error) {
        if (error.message === 'Unsafe trigger file' || error.message === 'Unsafe trigger directory') return { outcome: 'rejected', message: M.fileUnsafe }
        if (error.message === 'Invalid trigger slug') return { outcome: 'rejected', message: slug ? M.notFound(slug) : M.rejectedInput }
        if (error.message === 'Trigger definition changed') return { outcome: 'uncertain', message: M.uncertain }
    }
    return { outcome: 'uncertain', message: M.uncertain }
}
