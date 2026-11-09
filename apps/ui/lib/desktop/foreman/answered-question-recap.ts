import { z } from 'zod'
import { desktopQuestionInput, serializeAnswers, stripBridgePrefix, type QuestionItem } from '@rerun/contracts'

/** A saved answer recap exposes labels and the exact selection, never the request tokens,
 * guard digest, run identity or question hash used to prove the association. */
export type DesktopAnsweredQuestion = {
    question: string
    options: string[]
    multiple: boolean
    answers: string[]
}

export type DesktopAnsweredQuestionRecap = {
    /** Durable engine message id and tool-call id only; also the React key. */
    key: string
    sourceMessageId: string
    toolCallId: string
    questions: DesktopAnsweredQuestion[]
}

export type RecapHistoryMessage = { id: string; role: 'user' | 'assistant'; parts: readonly unknown[] }

const guardSchema = z.object({
    runId: z.string().min(1).max(256),
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

const answerIntentSchema = z.object({
    action: z.literal('answer'),
    requestId: z.string().uuid(),
    questionId: z.string().regex(/^[a-f0-9]{64}$/),
    answers: z.array(z.array(z.string().max(20_000)).max(101)).min(1).max(32),
}).strict()

const answerTurnSchema = z.object({
    text: z.string().min(1).max(20_000),
    question: guardSchema,
    answerIntent: answerIntentSchema,
}).passthrough()

const answeredRecapSchema = z.object({
    key: z.string().min(1).max(600),
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    questions: z.array(z.object({
        question: z.string().min(1).max(4000),
        options: z.array(z.string().max(500)).max(100),
        multiple: z.boolean(),
        answers: z.array(z.string().max(20_000)).max(101),
    }).strict()).min(1).max(32),
}).strict()

export { answeredRecapSchema as desktopAnsweredQuestionRecapSchema }

function messageText(message: RecapHistoryMessage): string {
    return message.parts.map(part => {
        const value = part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : {}
        return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
    }).join('')
}

type ToolPart = { toolName?: unknown; toolCallId?: unknown; input?: unknown; state?: unknown }

function answerQuestions(questions: readonly QuestionItem[], answers: readonly (readonly string[])[]): DesktopAnsweredQuestion[] | null {
    if (questions.length !== answers.length) return null
    const projected: DesktopAnsweredQuestion[] = []
    for (const [index, question] of questions.entries()) {
        const selected = answers[index]!.map(value => value.trim()).filter(Boolean)
        if (!question.multiple && selected.length > 1) return null
        if (typeof question.question !== 'string' || !question.question.trim() || question.question.length > 4000) return null
        const options = question.options.filter((option): option is string => typeof option === 'string' && !!option.trim() && option.length <= 500)
        if (options.length !== question.options.length) return null
        projected.push({ question: question.question, options, multiple: question.multiple === true, answers: selected })
    }
    return projected
}

/** Proof: one assistant row carries this exact ask_user call, the immediately following user row
 * carries exactly the answer text this turn persisted, and the stored selection re-serializes to
 * that same text. Anything else returns null so the caller keeps the ordinary transcript. */
function project(turn: z.infer<typeof answerTurnSchema>, messages: readonly RecapHistoryMessage[]): DesktopAnsweredQuestionRecap | null {
    const source = messages.findIndex(message => message.id === `engine-${turn.question.sourceMessageId}` && message.role === 'assistant')
    if (source < 0) return null
    const next = messages[source + 1]
    if (!next || next.role !== 'user') return null
    if (messageText(next) !== turn.text) return null
    const sourceMessage = messages[source]!
    const calls = sourceMessage.parts.filter((part): part is ToolPart => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return false
        const value = part as ToolPart
        return value.toolCallId === turn.question.toolCallId && typeof value.toolName === 'string' && stripBridgePrefix(value.toolName) === 'ask_user'
    })
    if (calls.length !== 1) return null
    if (calls[0]!.state !== 'output-available') return null
    const input = desktopQuestionInput(calls[0]!.input)
    if (!input) return null
    const answers = turn.answerIntent.answers.map(values => values.map(value => value.trim()).filter(Boolean))
    const questions = answerQuestions(input.questions, answers)
    if (!questions) return null
    const expected = serializeAnswers(input.questions.map((item, index) => ({ question: item.question, answers: answers[index]! })))
    if (expected !== turn.text) return null
    return {
        key: JSON.stringify([turn.question.sourceMessageId, turn.question.toolCallId]),
        sourceMessageId: turn.question.sourceMessageId,
        toolCallId: turn.question.toolCallId,
        questions,
    }
}

/**
 * Project saved Foreman answer turns against the reopened transcript. A turn is linked only by the
 * persisted source message id, tool-call id and the exact answer text; malformed, stale,
 * out-of-order or duplicate associations produce no recap.
 */
export function projectAnsweredQuestionRecaps(turnBodies: readonly unknown[], messages: readonly RecapHistoryMessage[]): DesktopAnsweredQuestionRecap[] {
    const byKey = new Map<string, { recap: DesktopAnsweredQuestionRecap; count: number }>()
    for (const raw of turnBodies) {
        let body: unknown = raw
        if (typeof raw === 'string') {
            try { body = JSON.parse(raw) } catch { continue }
        }
        const parsed = answerTurnSchema.safeParse(body)
        if (!parsed.success) continue
        const recap = project(parsed.data, messages)
        if (!recap) continue
        const current = byKey.get(recap.key)
        if (current) current.count += 1
        else byKey.set(recap.key, { recap, count: 1 })
    }
    return [...byKey.values()].filter(entry => entry.count === 1).map(entry => entry.recap)
}

/** Root attaches a recap to the exact engine message it belongs to. */
export function answeredQuestionRecapsForMessage(recaps: readonly DesktopAnsweredQuestionRecap[], messageId: string): DesktopAnsweredQuestionRecap[] {
    return recaps.filter(recap => messageId === `engine-${recap.sourceMessageId}`)
}
