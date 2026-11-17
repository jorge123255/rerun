import { describe, expect, it } from 'vitest'
import { phonePendingCards } from './phone-pending'

describe('phonePendingCards', () => {
    it('says nothing waits when nothing does', () => {
        expect(phonePendingCards(null, null)).toEqual({ question: null, approval: null })
    })

    it('carries the words of a question and of an approval', () => {
        const cards = phonePendingCards(
            { toolCallId: 'call-1', questions: [{ question: 'Which color?', header: 'Color', options: ['Red', 'Blue'], multiple: true }, { question: 'Anything else?', options: [] }] },
            { toolCallId: 'call-2', approvals: [{ action: 'Send the report', detail: 'To the whole team' }, { action: 'Rename it' }] },
        )
        expect(cards).toEqual({
            question: { toolCallId: 'call-1', questions: [{ question: 'Which color?', header: 'Color', options: ['Red', 'Blue'], multiple: true }, { question: 'Anything else?', options: [], multiple: false }] },
            approval: { toolCallId: 'call-2', approvals: [{ action: 'Send the report', detail: 'To the whole team' }, { action: 'Rename it' }] },
        })
    })

    it('leaves out everything the Mac keeps to itself', () => {
        const question = { toolCallId: 'call-1', questions: [{ question: 'Which color?', options: [] }], id: 'saved-question', sourceMessageId: 'message-1', fingerprint: 'print', attempt: { requestId: 'run-1' } }
        const approval = { toolCallId: 'call-2', approvals: [{ action: 'Send it' }], id: 'saved-approval', sourceMessageId: 'message-2', fingerprint: 'print' }
        const text = JSON.stringify(phonePendingCards(question, approval))
        for (const kept of ['saved-question', 'saved-approval', 'message-1', 'message-2', 'print', 'run-1']) expect(text).not.toContain(kept)
    })
})
