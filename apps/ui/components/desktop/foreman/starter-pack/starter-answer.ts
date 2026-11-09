/** Proposed UI adapter only: root must bind an authenticated durable CAS authority before mounting. */
export type StarterRequest = {
    workspaceId: string
    chatId: string
    requestId: string
    revision: string
}
export type StarterTextAnswer = { answered: true; custom: string }
export type StarterReceipt = StarterRequest & { answer: StarterTextAnswer; receiptId: string }
export type StarterAnswerPorts = {
    /** Must recover receipts even after the pending request was consumed. Never resumes a run. */
    receipt(request: StarterRequest): Promise<StarterReceipt | null>
    /** Atomically verify active workspace/chat, pending request/revision and Stop state; persist
     * one answer and its receipt before resumption. All card/text/dismiss writers share this CAS.
     * Duplicate identical answers recover the same receipt; conflicting answers must refuse. */
    answer(request: StarterRequest, answer: StarterTextAnswer): Promise<StarterReceipt>
}
export type StarterAnswerResult =
    | { status: 'confirmed'; receipt: StarterReceipt }
    | { status: 'unavailable' | 'invalid' | 'stale' | 'duplicate' | 'uncertain' }
const sameRequest = (a: StarterRequest, b: StarterRequest) =>
    a.workspaceId === b.workspaceId && a.chatId === b.chatId && a.requestId === b.requestId && a.revision === b.revision
const valid = (request: StarterRequest) => Object.values(request).every(value => typeof value === 'string' && value.trim().length > 0)

/** No effects at construction or restoration. Call only from an explicit composer submit.
 * readActive must return null while stopped, restoring, blocked or outside this workspace/chat.
 * This local lock is only a UX guard; the port's durable CAS is the authority across remounts.
 */
export function createStarterTextAnswerAdapter(readActive: () => StarterRequest | null, ports?: StarterAnswerPorts) {
    const inFlight = new Set<string>()
    const attempted = new Set<string>()
    return async (request: StarterRequest, text: string): Promise<StarterAnswerResult> => {
        const custom = text.trim()
        if (!valid(request) || !custom) return { status: 'invalid' }
        if (!ports) return { status: 'unavailable' }
        const key = JSON.stringify([request.workspaceId, request.chatId, request.requestId, request.revision])
        if (inFlight.has(key)) return { status: 'duplicate' }
        inFlight.add(key)
        const current = () => { const active = readActive(); return active !== null && sameRequest(active, request) }
        const confirm = (receipt: StarterReceipt): StarterAnswerResult => {
            if (!sameRequest(receipt, request) || !receipt.receiptId?.trim() || receipt.answer?.answered !== true || receipt.answer.custom !== custom) return { status: 'uncertain' }
            // Do not clear a draft or paint a result in a different/superseding conversation.
            if (!current()) return { status: 'stale' }
            return { status: 'confirmed', receipt }
        }
        try {
            if (!current()) return { status: 'stale' }
            const saved = await ports.receipt(request)
            if (saved) return confirm(saved)
            if (!current()) return { status: 'stale' }
            // An ambiguous write is never retried automatically. Further submits only look up proof.
            if (attempted.has(key)) return { status: 'uncertain' }
            attempted.add(key)
            return confirm(await ports.answer(request, { answered: true, custom }))
        } catch {
            return { status: 'uncertain' }
        } finally {
            inFlight.delete(key)
        }
    }
}
