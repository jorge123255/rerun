'use client'

import type { Ref } from 'react'
import { PeekRequest, PeekSent, PeekSkeleton, type PeekNotice, type PeekPhase } from '@/components/notifications/PendingRequestPeekBody'
import { DesktopApprovalCard } from './DesktopApprovalCard'
import { DesktopQuestionCard } from './DesktopQuestionCard'
import type { DesktopInboxPeek, DesktopPeekAnswer } from './useDesktopInboxPeek'

/**
 * The body of a peeked request on the Mac, in the inbox card and under a thread row of General:
 * upstream's shared peek body (#333) with the Mac's own question and approval cards as its form,
 * so an answer is built and checked exactly as in the conversation.
 */
export function DesktopPeekBody({ peek, waiting, phase, notice, attempt, agentId, agentName, disabled = false, widgetRef, className, onSubmit, onDismiss }: {
    peek: DesktopInboxPeek
    /** The conversation is still listed as needing the person. */
    waiting: boolean
    phase: PeekPhase
    notice: PeekNotice | null
    attempt: number
    agentId: string
    agentName: string
    /** A coworker turned off cannot be answered. */
    disabled?: boolean
    widgetRef?: Ref<HTMLDivElement>
    className?: string
    onSubmit: (answer: DesktopPeekAnswer) => Promise<void>
    onDismiss: () => void
}) {
    if (peek.state === 'loading') return <PeekSkeleton className={className} />
    const pending = peek.state === 'ready' ? peek.peek.pending : null
    if (phase.step === 'sent') {
        return (
            <div data-desktop-peek-sent className={className}>
                <PeekSent text={phase.text} pending={pending} agentId={agentId} agentName={agentName} />
            </div>
        )
    }
    // Still waiting, yet neither a question nor an approval: an app to connect, a credential, a
    // sign-in, the browser, or a connector call to allow. Those are answered in the conversation.
    const shown = peek.state === 'ready' && !pending && waiting ? { state: 'unreadable' as const } : peek
    const { question, approval } = peek.state === 'ready' ? peek : { question: null, approval: null }
    return (
        <div data-desktop-peek-request className={className}>
            <PeekRequest
                peek={shown}
                phase={phase}
                notice={notice}
                attempt={attempt}
                agentId={agentId}
                agentName={agentName}
                widgetRef={widgetRef}
                onSubmit={() => {}}
                onDismiss={onDismiss}
                renderWidget={() =>
                    question ? <DesktopQuestionCard key={`${question.id}:${attempt}`} question={question} disabled={disabled} onAnswer={payload => onSubmit({ kind: 'question', payload })} />
                    : approval ? <DesktopApprovalCard key={`${approval.id}:${attempt}`} approval={approval} disabled={disabled} onDecide={payload => onSubmit({ kind: 'approval', payload })} />
                    : null}
            />
        </div>
    )
}
