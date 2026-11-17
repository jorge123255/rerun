import { z } from 'zod'
import { desktopPendingApprovalSchema } from './approvals'
import { desktopPendingQuestionSchema } from './questions'

// What one conversation waits on, read without opening it (upstream #272): the same pending
// question or approval its chat card shows, with the coworker's words around it. Reading it never
// answers, approves, marks read or opens anything. Any other kind of request (an app to connect,
// a credential, a sign-in, the browser) is answered in its conversation and reads as neither.
const PEEK_TEXT_MAX = 20_000
export const desktopPendingPeekSchema = z.object({
    question: desktopPendingQuestionSchema.nullable(),
    approval: desktopPendingApprovalSchema.nullable(),
    /** What the coworker wrote to ask: the paragraph right before its request, and any after it. */
    ask: z.string().max(PEEK_TEXT_MAX),
    /** What it wrote before that, in the same turn or the turn before. */
    before: z.string().max(PEEK_TEXT_MAX).nullable(),
}).strict()
export type DesktopPendingPeek = z.infer<typeof desktopPendingPeekSchema>
export const DESKTOP_PENDING_PEEK_TEXT_MAX = PEEK_TEXT_MAX
export const desktopPendingPeekUrl = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/pending-peek`
/** The kinds of pending request the inbox and a thread row answer in place. */
export const DESKTOP_PEEK_KINDS: ReadonlySet<string> = new Set(['question', 'approval'])
