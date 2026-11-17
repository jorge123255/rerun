import 'server-only'
import { transformEngineMessages } from '@/lib/chat/engine-history'
import { pendingRequestPeek } from '@/lib/chat/pending-request-peek'
import { DESKTOP_PENDING_PEEK_TEXT_MAX, type DesktopPendingPeek } from '../pending-peek'
import { readDesktopApproval } from './approvals'
import { createDesktopHumanRequestHistory, readDesktopHumanRequestMessages, readDesktopHumanRequestTarget } from './human-request-history'
import { readDesktopQuestion } from './questions'
import type { DesktopRuntime } from './runtime'

const clip = (text: string) => text.slice(0, DESKTOP_PENDING_PEEK_TEXT_MAX)

// Read-only, like the two resolvers it calls: the question and the approval are the ones the chat
// card reads, receipts included, from one transcript read. The words around the request come from
// upstream's `pendingRequestPeek`, and only when it finds the same tool call: a transcript it reads
// differently gives the request with no context rather than the context of another request.
export async function readDesktopPendingPeek(runtime: DesktopRuntime, sessionId: string, signal?: AbortSignal): Promise<DesktopPendingPeek> {
    const target = await readDesktopHumanRequestTarget(runtime, sessionId)
    const options = { signal, history: createDesktopHumanRequestHistory(runtime, target.agent.id, signal) }
    const [{ question }, { approval }] = await Promise.all([readDesktopQuestion(runtime, sessionId, options), readDesktopApproval(runtime, sessionId, options)])
    const pending = question ?? approval
    if (!pending || (question && approval)) return { question, approval, ask: '', before: null }
    try {
        const around = pendingRequestPeek(transformEngineMessages(await readDesktopHumanRequestMessages(runtime, target, options)))
        if (around.pending?.toolCallId === pending.toolCallId) return { question, approval, ask: clip(around.ask), before: around.before ? clip(around.before) : null }
    } catch { /* The request itself was read; its context is a convenience. */ }
    return { question, approval, ask: '', before: null }
}
