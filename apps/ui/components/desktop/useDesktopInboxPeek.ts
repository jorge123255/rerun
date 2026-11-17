'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions } from '@rerun/contracts'
import { usePeekAnswer } from '@/components/notifications/PendingRequestPeekBody'
import type { PeekAnswerOutcome } from '@/hooks/useInboxPeek'
import type { PendingRequestPeek } from '@/lib/chat/pending-request-peek'
import type { DesktopApprovalAnswer, DesktopPendingApproval } from '@/lib/desktop/approvals'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { desktopPendingPeekSchema, desktopPendingPeekUrl } from '@/lib/desktop/pending-peek'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'

/** What a conversation waits on, in the shape upstream's peek body reads, with the Mac's own request beside it. */
export type DesktopInboxPeek =
    | { state: 'loading' }
    | { state: 'unreadable' }
    | { state: 'ready'; sessionId: string; peek: PendingRequestPeek; question: DesktopPendingQuestion | null; approval: DesktopPendingApproval | null }

/** An answer exactly as the conversation's own card builds it. */
export type DesktopPeekAnswer = { kind: 'question'; payload: DesktopQuestionAnswer } | { kind: 'approval'; payload: DesktopApprovalAnswer }

const ANSWER_TIMEOUT_MS = 60_000
const sessionUrl = (sessionId: string, route: 'questions' | 'approvals') => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/${route}`
const requestIdOf = (answer: DesktopPeekAnswer) => (answer.kind === 'question' ? answer.payload.questionId : answer.payload.approvalId)
const pendingIdOf = (peek: DesktopInboxPeek) => (peek.state === 'ready' ? (peek.question?.id ?? peek.approval?.id ?? null) : null)

async function readPeek(sessionId: string, signal?: AbortSignal): Promise<DesktopInboxPeek> {
    const response = await fetch(desktopPendingPeekUrl(sessionId), { cache: 'no-store', signal })
    if (!response.ok) return { state: 'unreadable' }
    const { question, approval, ask, before } = desktopPendingPeekSchema.parse(await response.json())
    // Two requests at once is a conversation that changed while it was read: it is opened, not guessed at.
    if (question && approval) return { state: 'unreadable' }
    const pending = question ? { kind: 'question' as const, toolCallId: question.toolCallId, input: { questions: question.questions } }
        : approval ? { kind: 'approval' as const, toolCallId: approval.toolCallId, input: { approvals: approval.approvals } } : null
    return { state: 'ready', sessionId, peek: { pending, ask, before }, question, approval }
}

/** The words the conversation shows for this answer: the same text its own card sends beside the payload. */
export function desktopPeekAnswerText(peek: DesktopInboxPeek, answer: DesktopPeekAnswer): string {
    if (peek.state !== 'ready') return ''
    if (answer.kind === 'question') {
        if (answer.payload.action === 'cancel') return HITL_CANCELLED.question
        const { answers } = answer.payload
        return serializeAnswers((peek.question?.questions ?? []).map((item, index) => ({ question: item.question, answers: answers[index] ?? [] })))
    }
    return serializeApprovalDecisions((peek.approval?.approvals ?? []).map((item, index) => ({ ...item, ...answer.payload.decisions[index]! })))
}

/**
 * Reads what a conversation waits on and answers it without opening it (upstream #272-#274,
 * `useInboxPeek`). Reading goes through the read-only peek route. An answer is posted to the very
 * routes the conversation's own cards use (`/questions`, `/approvals`), with the same payload, so
 * every check they make applies; the reply's stream is let go once the server has confirmed it, and
 * the conversation attaches to that run when it is opened.
 */
export function useDesktopInboxPeek(sessionId: string, enabled = true, revision?: string) {
    const [peek, setPeek] = useState<DesktopInboxPeek>({ state: 'loading' })
    const latest = useRef(peek)
    latest.current = peek
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

    useEffect(() => {
        if (!enabled) return
        const controller = new AbortController()
        readPeek(sessionId, controller.signal)
            .catch((): DesktopInboxPeek => ({ state: 'unreadable' }))
            .then(next => { if (!controller.signal.aborted) setPeek(next) })
        return () => controller.abort()
    }, [sessionId, enabled, revision])

    const answer = useCallback(async (input: DesktopPeekAnswer): Promise<PeekAnswerOutcome> => {
        if (isDesktopQuitting()) return 'failed'
        const id = requestIdOf(input)
        if (pendingIdOf(latest.current) !== id) return 'stale'
        // The card may have stayed open while the request was answered in its conversation: read
        // again right before sending, so an answer never goes to a request that is gone.
        const reread = async () => {
            const next = await readPeek(sessionId).catch((): DesktopInboxPeek => ({ state: 'unreadable' }))
            if (mounted.current) setPeek(next)
            return next
        }
        const fresh = await reread()
        if (fresh.state === 'unreadable') return 'failed'
        if (pendingIdOf(fresh) !== id) return 'stale'
        let response: Response
        try {
            response = await fetch(sessionUrl(sessionId, input.kind === 'question' ? 'questions' : 'approvals'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.payload), cache: 'no-store', signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
            })
        } catch {
            // The server may have saved the attempt: the next read shows it for an exact retry.
            await reread()
            return 'failed'
        }
        const confirmed = response.ok && response.headers.get('x-session-id') === sessionId && !!response.headers.get('x-run-id')
            && (response.headers.get(input.kind === 'question' ? 'x-question-id' : 'x-approval-id') === id || !!response.headers.get('x-trigger-request-key'))
        // The run goes on without a reader: the conversation attaches to it when opened.
        void response.body?.cancel().catch(() => {})
        if (confirmed) return 'sent'
        const after = await reread()
        if (response.status !== 409) return 'failed'
        // Refused: either the request is gone, or the coworker is still busy with a run.
        return pendingIdOf(after) === id ? 'busy' : 'stale'
    }, [sessionId])

    return { peek, answer }
}

/**
 * Upstream's `usePeekAnswer` phases (asking, sending, the receipt, stale) around the Mac's typed
 * answer: the card hands over its payload, the phases keep the text for the receipt.
 */
export function useDesktopPeekAnswer(peek: DesktopInboxPeek, answer: (input: DesktopPeekAnswer) => Promise<PeekAnswerOutcome>, onDone: (rearm: () => void) => void) {
    const handed = useRef<DesktopPeekAnswer | null>(null)
    const phases = usePeekAnswer(async () => {
        const input = handed.current
        handed.current = null
        return input ? answer(input) : 'failed'
    }, onDone)
    const submit = (input: DesktopPeekAnswer) => {
        handed.current = input
        return phases.submit(desktopPeekAnswerText(peek, input))
    }
    return { ...phases, submit }
}
