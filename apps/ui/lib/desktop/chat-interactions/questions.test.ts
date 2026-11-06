import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { pendingQuestions, serializeAnswers, withHitlVersion, HITL_CANCELLED } from '../../../../../packages/contracts/src/chat-hitl'
import { prepareDesktopQuestionInput, projectDesktopQuestionInput } from './questions'
import { createQuestionAnswerAdapter } from './answer'
import { LEGACY_QUESTION_BYTES, LEGACY_QUESTION_FINGERPRINT, LEGACY_SINGULAR_BYTES, DESCRIBED_QUESTION_BYTES, ACCEPTED_LEGACY_ANSWER_BYTES, interaction } from './fixtures'
const requestId = '00000000-0000-4000-8000-000000000001'
const answer = { action: 'answer' as const, questionId: 'a'.repeat(64), requestId, answers: [['Plain']] }
test('stored legacy payloads retain exact fingerprint bytes, question IDs and serialized answers', () => {
    for (const raw of [LEGACY_QUESTION_BYTES, LEGACY_SINGULAR_BYTES, JSON.stringify({ ...JSON.parse(LEGACY_QUESTION_BYTES), v: 2, ignored: 'old', questions: [{ question: 'Choose a format', header: 'previously ignored', options: ['Plain', 'Rich'], multiple: false }] })]) {
        const projected = projectDesktopQuestionInput(raw)!
        expect(projected.fingerprint).toBe(LEGACY_QUESTION_FINGERPRINT)
        const id = (fingerprint: string) => createHash('sha256').update(JSON.stringify(['agent-one', 'chat-one', interaction.messageId, interaction.toolCallId, fingerprint])).digest('hex')
        expect(id(projected.fingerprint)).toBe(id(JSON.stringify(pendingQuestions(JSON.parse(raw)))))
    }
    expect(JSON.stringify({ action: answer.action, answers: answer.answers })).toBe(ACCEPTED_LEGACY_ANSWER_BYTES)
    expect(serializeAnswers([{ question: 'Choose a format', answers: ['Plain'] }])).toBe('Here are my answers:\n\n**Choose a format**\nPlain')
    expect(HITL_CANCELLED.question).toBe('[User dismissed the questions without answering]')
})
test('new described/header questions use an explicit projection, without mutating saved bytes', () => {
    const raw = JSON.parse(DESCRIBED_QUESTION_BYTES), before = JSON.stringify(raw), projected = projectDesktopQuestionInput(raw)!
    expect(projected.presentationVersion).toBe(2); expect(projected.questions[0].header).toBe('Format')
    expect(projected.questions[0].options[0]).toEqual({ label: 'Plain', description: 'Easy to edit' })
    expect(JSON.stringify(raw)).toBe(before)
    expect(projected.fingerprint).not.toBe(LEGACY_QUESTION_FINGERPRINT)
    const stamped = prepareDesktopQuestionInput({ questions: [{ question: 'Choose', header: 'Format', options: ['Plain', 'Rich'] }] })
    expect(stamped.desktopQuestionPresentationVersion).toBe(2)
    expect(prepareDesktopQuestionInput({ ...stamped, v: 2 }).desktopQuestionPresentationVersion).toBe(2)
    expect(withHitlVersion('ask_user', raw)).toBe(raw)
    expect(projectDesktopQuestionInput({ ...raw, questions: [{ question: 'Bad', options: [{ label: 'A' }, { label: '' }] }] })).toBeNull()
    expect(projectDesktopQuestionInput({ ...raw, v: 3 })).toBeNull()
    expect(projectDesktopQuestionInput({ ...raw, desktopQuestionPresentationVersion: 99 })).toBeNull()
    expect(projectDesktopQuestionInput({ ...raw, v: 1, desktopQuestionPresentationVersion: 2 })).toBeNull()
})
test('lost ACK retries exactly the saved request; a late accepted answer remains committed after Stop', async () => {
    let calls = 0, current: typeof interaction | null = interaction
    const received: string[] = []
    const adapter = createQuestionAnswerAdapter(interaction, { id: answer.questionId, messageId: interaction.messageId, toolCallId: interaction.toolCallId }, {
        current: () => current, answer: async payload => { received.push(payload.requestId); if (++calls === 1) throw Error('Lost ACK'); current = null },
    })
    await expect(adapter.answer(answer)).rejects.toThrow('Lost ACK')
    await expect(adapter.answer({ ...answer, requestId: '00000000-0000-4000-8000-000000000002' })).rejects.toThrow('exact saved answer')
    await expect(adapter.answer(answer)).rejects.toThrow('was accepted')
    current = interaction
    await expect(adapter.answer(answer)).rejects.toThrow('accepted answer')
    expect(received).toEqual([requestId, requestId])
})
test('concurrent/duplicate answers use one canonical callback and a resolved card cannot answer again', async () => {
    let resolve!: () => void, calls = 0
    const adapter = createQuestionAnswerAdapter(interaction, { id: answer.questionId, messageId: interaction.messageId, toolCallId: interaction.toolCallId }, {
        current: () => interaction, answer: async () => { calls++; await new Promise<void>(done => { resolve = done }) },
    })
    const first = adapter.answer(answer), duplicate = adapter.answer(answer)
    expect(duplicate).toBe(first); expect(calls).toBe(1)
    resolve(); await first
    await expect(adapter.answer(answer)).rejects.toThrow('accepted answer')
})
test('saved unanswered attempts restore observationally and late/Stopped callbacks cannot dispatch', async () => {
    let current: typeof interaction | null = interaction, calls = 0
    const adapter = createQuestionAnswerAdapter(interaction, { id: answer.questionId, messageId: interaction.messageId, toolCallId: interaction.toolCallId, attempt: { action: 'answer', requestId, answers: [['Plain']] } }, {
        current: () => current, answer: async () => { calls++ },
    })
    expect(calls).toBe(0)
    await expect(adapter.answer({ ...answer, answers: [['Rich']] })).rejects.toThrow('saved answer')
    current = { ...interaction, tabUid: 'other-tab' }
    await expect(adapter.answer(answer)).rejects.toThrow('current'); expect(calls).toBe(0)
    current = interaction; adapter.close(); await expect(adapter.answer(answer)).rejects.toThrow('current')
})
