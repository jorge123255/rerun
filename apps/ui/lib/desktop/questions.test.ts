import { expect, it } from 'vitest'
import { findDesktopQuestion } from '@rerun/contracts'
import { desktopPendingQuestionSchema } from './questions'

it('retains the exact legacy options and saved identity without rewriting the receipt fingerprint', () => {
    const rows = [
        { id: 'source-message', role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName: 'ask_user', toolCallId: 'source-call', input: { questions: [{ question: 'Choose a color', options: ['Blue', 'Green'] }] } }]) },
        { id: 'source-result', role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'source-call', output: { status: 'delivered' } }]) },
    ]
    const saved = findDesktopQuestion(rows)!
    expect(saved.fingerprint).toBe('[{"question":"Choose a color","options":["Blue","Green"],"multiple":false}]')
    const before = JSON.stringify(rows)
    const view = desktopPendingQuestionSchema.parse({ id: 'a'.repeat(64), messageId: saved.sourceMessageId, toolCallId: saved.toolCallId, questions: saved.questions })
    expect(view).toEqual({ id: 'a'.repeat(64), messageId: 'source-message', toolCallId: 'source-call', questions: [{ question: 'Choose a color', options: ['Blue', 'Green'], multiple: false }] })
    expect(findDesktopQuestion(rows)).toEqual(saved)
    expect(JSON.stringify(rows)).toBe(before)
})

it('accepts described options additively without converting existing string choices', () => {
    const view = { id: 'b'.repeat(64), messageId: 'message', toolCallId: 'call', questions: [{ question: 'Pick a plan', header: 'Plan', options: ['Keep current', { label: 'Upgrade', description: 'Use the next tier' }] }] }
    expect(desktopPendingQuestionSchema.parse(view)).toEqual(view)
    expect(desktopPendingQuestionSchema.safeParse({ ...view, questions: [{ question: 'Pick a plan', options: [{ label: 'Upgrade', token: 'not-a-public-option-field' }] }] }).success).toBe(false)
})
