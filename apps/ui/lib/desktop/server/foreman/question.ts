import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DESKTOP_FOREMAN_TURN_TEXT_LIMIT, foremanQuestionGuardSchema, HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions } from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import { desktopPendingApprovalSchema, type DesktopApprovalAnswer } from '../../approvals'
import { desktopPendingQuestionSchema, type DesktopQuestionAnswer } from '../../questions'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import type { ForemanChat } from './chat-store'

const resultSchema = z.object({ question: z.object({
    guard: foremanQuestionGuardSchema,
    questions: desktopPendingQuestionSchema.shape.questions,
}).nullable(), approval: z.object({
    guard: foremanQuestionGuardSchema,
    approvals: desktopPendingApprovalSchema.shape.approvals,
}).nullable().optional() })

export async function readPendingForemanRequests(runtime: DesktopRuntime, owner: ForemanChat) {
    const { question, approval } = await request(engineOf(runtime), `/desktop/foreman/question?sessionId=${encodeURIComponent(owner.sessionId)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(10_000) }, value => resultSchema.parse(value))
    function identity(guard: z.infer<typeof foremanQuestionGuardSchema>, kind?: 'approval') {
        const id = createHash('sha256').update(JSON.stringify([owner.chat.workspaceId, owner.chat.chatId, owner.sessionId,
            guard.runId, guard.sourceMessageId, guard.toolCallId, guard.digest, ...(kind ? [kind] : [])])).digest('hex')
        return { id, messageId: guard.sourceMessageId, toolCallId: guard.toolCallId }
    }
    return {
        question: question ? { guard: question.guard, view: { ...identity(question.guard), questions: question.questions } } : null,
        approval: approval ? { guard: approval.guard, view: { ...identity(approval.guard, 'approval'), approvals: approval.approvals } } : null,
    }
}

type Pending = Awaited<ReturnType<typeof readPendingForemanRequests>>

export function foremanApprovalText(approval: NonNullable<Pending['approval']>, answer: DesktopApprovalAnswer) {
    if (approval.view.id !== answer.approvalId) throw new DesktopHttpError(409, 'This Foreman approval has changed. Reopen it before deciding.')
    if (approval.view.approvals.length !== answer.decisions.length) throw new DesktopHttpError(400, 'Approve or decline each action in this form.')
    const text = serializeApprovalDecisions(approval.view.approvals.map((item, index) => ({ ...item, ...answer.decisions[index] })))
    if (text.length > DESKTOP_FOREMAN_TURN_TEXT_LIMIT) throw new DesktopHttpError(400, 'Shorten the decisions before sending them.')
    return text
}

export function foremanQuestionText(question: NonNullable<Pending['question']>, answer: DesktopQuestionAnswer) {
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
