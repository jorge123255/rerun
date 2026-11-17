import type { DesktopApproval, DesktopQuestion } from '@rerun/contracts'

// What a paired phone is shown of a request waiting on the person: the words of the question or of
// the action, never the saved receipt, the source message or anything that would let the phone answer
// in the Mac's name. The Mac's own form stays the place where a decision is recorded.
export type PhonePendingCards = {
    question: { toolCallId: string; questions: { question: string; header?: string; options: string[]; multiple: boolean }[] } | null
    approval: { toolCallId: string; approvals: { action: string; detail?: string }[] } | null
    // A request only this Mac can settle (a held app action, a secret, a sign-in, a browser, a tool to
    // install): the phone says so and what it is about, and offers nothing to decide.
    macOnly?: { kind: PhoneMacOnlyKind; summary: string } | null
}

export type PhoneMacOnlyKind = 'connector' | 'secret' | 'service' | 'mcp' | 'takeover' | 'tool-install'

export function phonePendingCards(question: Pick<DesktopQuestion, 'toolCallId' | 'questions'> | null, approval: Pick<DesktopApproval, 'toolCallId' | 'approvals'> | null): PhonePendingCards {
    return {
        question: question && {
            toolCallId: question.toolCallId,
            questions: question.questions.map(item => ({
                question: item.question,
                ...(item.header ? { header: item.header } : {}),
                options: item.options.map(option => typeof option === 'string' ? option : option.label),
                multiple: item.multiple === true,
            })),
        },
        approval: approval && {
            toolCallId: approval.toolCallId,
            approvals: approval.approvals.map(item => ({ action: item.action, ...(item.detail ? { detail: item.detail } : {}) })),
        },
    }
}
