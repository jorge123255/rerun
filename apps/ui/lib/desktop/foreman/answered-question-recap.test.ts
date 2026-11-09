import { describe, expect, it } from 'vitest'
import { serializeAnswers } from '@rerun/contracts'
import {
    answeredQuestionRecapsForMessage,
    projectAnsweredQuestionRecaps,
    type RecapHistoryMessage,
} from './answered-question-recap'

const questions = [
    { question: 'Which color?', options: ['Red', 'Blue'], multiple: false },
    { question: 'Anything else?', options: [], multiple: false },
]
const answers = [['Blue'], ['Ship it']]
const text = serializeAnswers(questions.map((item, index) => ({ question: item.question, answers: answers[index]! })))
const guard = { runId: crypto.randomUUID(), sourceMessageId: 'question-message', toolCallId: 'ask-call', digest: 'a'.repeat(64) }
const turn = {
    text,
    question: guard,
    answerIntent: { action: 'answer' as const, requestId: crypto.randomUUID(), questionId: 'b'.repeat(64), answers },
}
const assistant = (over: Record<string, unknown> = {}): RecapHistoryMessage => ({
    id: 'engine-question-message', role: 'assistant', parts: [{
        type: 'tool-ask_user', toolName: 'ask_user', toolCallId: 'ask-call', state: 'output-available',
        input: { questions }, output: { status: 'delivered' }, ...over,
    }],
})
const answerRow: RecapHistoryMessage = { id: 'engine-answer-message', role: 'user', parts: [{ type: 'text', text }] }

describe('answered Foreman question recap', () => {
    it('links the exact saved turn to its persisted question and selection, with labels and no guard metadata', () => {
        const [recap] = projectAnsweredQuestionRecaps([JSON.stringify(turn)], [assistant(), answerRow])
        expect(recap).toEqual({
            key: JSON.stringify(['question-message', 'ask-call']),
            sourceMessageId: 'question-message',
            toolCallId: 'ask-call',
            questions: [
                { question: 'Which color?', options: ['Red', 'Blue'], multiple: false, answers: ['Blue'] },
                { question: 'Anything else?', options: [], multiple: false, answers: ['Ship it'] },
            ],
        })
        expect(JSON.stringify(recap)).not.toContain(guard.runId)
        expect(JSON.stringify(recap)).not.toContain(guard.digest)
        expect(JSON.stringify(recap)).not.toContain(turn.answerIntent.requestId)
        expect(JSON.stringify(recap)).not.toContain(turn.answerIntent.questionId)
    })

    it('accepts the bridged tool name and an input serialized as JSON', () => {
        const [recap] = projectAnsweredQuestionRecaps([turn], [assistant({ toolName: 'mcp__rerun__ask_user', input: JSON.stringify({ questions }) }), answerRow])
        expect(recap?.questions[0]?.answers).toEqual(['Blue'])
    })

    it('never links a stale, out-of-order, unanswered, malformed or ambiguously duplicated turn', () => {
        const cases = [
            { name: 'answer not immediately after the question', messages: [assistant(), { id: 'interlude', role: 'user', parts: [{ type: 'text', text: 'Something else' }] }, answerRow] as RecapHistoryMessage[] },
            { name: 'answer before the question', messages: [answerRow, assistant()] as RecapHistoryMessage[] },
            { name: 'different source message id', messages: [{ ...assistant(), id: 'engine-other' }, answerRow] as RecapHistoryMessage[] },
            { name: 'another user text', messages: [assistant(), { ...answerRow, parts: [{ type: 'text', text: 'Something else' }] }] as RecapHistoryMessage[] },
            { name: 'tool call still pending', messages: [assistant({ state: 'input-available', output: undefined }), answerRow] as RecapHistoryMessage[] },
            { name: 'duplicate matching calls', messages: [{ ...assistant(), parts: [...assistant().parts, ...assistant().parts] } as RecapHistoryMessage, answerRow] as RecapHistoryMessage[] },
        ]
        for (const item of cases) expect(projectAnsweredQuestionRecaps([turn], item.messages), item.name).toEqual([])
        expect(projectAnsweredQuestionRecaps([{ ...turn, answerIntent: { ...turn.answerIntent, answers: [['Blue']] } }], [assistant(), answerRow])).toEqual([])
        expect(projectAnsweredQuestionRecaps([{ ...turn, text: 'Not the saved answer' }], [assistant(), answerRow])).toEqual([])
        expect(projectAnsweredQuestionRecaps([{ ...turn, answerIntent: { ...turn.answerIntent, action: 'cancel' } }], [assistant(), answerRow])).toEqual([])
        expect(projectAnsweredQuestionRecaps([{ ...turn, question: { ...guard, digest: 'not-a-digest' } }], [assistant(), answerRow])).toEqual([])
        expect(projectAnsweredQuestionRecaps([turn, turn], [assistant(), answerRow])).toEqual([])
    })

    it('drops a question repeated by more than one saved answer turn instead of guessing', () => {
        expect(projectAnsweredQuestionRecaps([turn, turn], [assistant(), answerRow])).toEqual([])
    })

    it('groups recaps by the exact reopened engine message', () => {
        const recaps = projectAnsweredQuestionRecaps([turn], [assistant(), answerRow])
        expect(answeredQuestionRecapsForMessage(recaps, 'engine-question-message')).toHaveLength(1)
        expect(answeredQuestionRecapsForMessage(recaps, 'engine-answer-message')).toEqual([])
    })
})
