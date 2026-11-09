import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { foremanQuestionGuardSchema, HITL_CANCELLED, serializeAnswers } from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import { desktopPendingQuestionSchema, type DesktopQuestionAnswer } from '../../questions'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import type { ForemanChat } from './chat-store'

const resultSchema = z.object({ question: z.object({
    guard: foremanQuestionGuardSchema,
    questions: desktopPendingQuestionSchema.shape.questions,
}).nullable() })

export async function readPendingForemanQuestion(runtime: DesktopRuntime, owner: ForemanChat) {
    const { question } = await request(engineOf(runtime), `/desktop/foreman/question?sessionId=${encodeURIComponent(owner.sessionId)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(10_000) }, value => resultSchema.parse(value))
    if (!question) return null
    const { guard } = question
    const id = createHash('sha256').update(JSON.stringify([owner.chat.workspaceId, owner.chat.chatId, owner.sessionId,
        guard.runId, guard.sourceMessageId, guard.toolCallId, guard.digest])).digest('hex')
    return { guard, view: { id, messageId: guard.sourceMessageId, toolCallId: guard.toolCallId, questions: question.questions } }
}

export function foremanQuestionText(question: NonNullable<Awaited<ReturnType<typeof readPendingForemanQuestion>>>, answer: DesktopQuestionAnswer) {
    if (question.view.id !== answer.questionId) throw new DesktopHttpError(409, 'This Foreman question has changed. Reopen it before answering.')
    if (answer.action === 'cancel') return HITL_CANCELLED.question
    const questions = question.view.questions
    const answers = answer.answers.map(values => values.map(value => value.trim()).filter(Boolean))
    if (questions.length !== answers.length || questions.some((item, index) => !item.multiple && answers[index].length > 1)) {
        throw new DesktopHttpError(400, 'Answer or skip each question, and choose only one answer where requested.')
    }
    const text = serializeAnswers(questions.map((item, index) => ({ question: item.question, answers: answers[index] })))
    if (text.length > 20_000) throw new DesktopHttpError(400, 'Shorten the answers before sending them.')
    return text
}
