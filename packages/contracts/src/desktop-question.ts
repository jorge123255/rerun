import { z } from 'zod'
import { pendingQuestions, type QuestionItem } from './chat-hitl.js'
import { stripBridgePrefix } from './chat-tool-name.js'

const MAX_QUESTION_CHARS = 32_768
export const desktopQuestionGuardSchema = z.object({
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    fingerprint: z.string().min(1).max(MAX_QUESTION_CHARS),
}).strict()
export type DesktopQuestionGuard = z.infer<typeof desktopQuestionGuardSchema>
export type DesktopQuestion = DesktopQuestionGuard & { questions: QuestionItem[]; requestedAt?: string | null }
type QuestionRow = { id: string; role: string; contentJson: string; toolCallsJson?: string | null; createdAt?: string | null }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function json(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch { return value }
}

// Use the original question/answer protocol, while keeping a malformed or oversized provider
// payload from becoming an actionable desktop form. Reject rather than truncate its choices.
export function desktopQuestionInput(raw: unknown): { questions: QuestionItem[] } | null {
    const input = record(json(raw))
    const batch = json(input.questions)
    const entries = Array.isArray(batch) ? batch : input.question !== undefined ? [input] : []
    if (!entries.length || entries.length > 32) return null
    for (const value of entries) {
        const item = record(value)
        if (typeof item.question !== 'string' || !item.question.trim() || item.question.length > 4000) return null
        const options = item.options ?? item.suggestions
        if (options != null && (!Array.isArray(options) || options.length > 100 || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 500))) return null
        if (item.multiple != null && typeof item.multiple !== 'boolean') return null
    }
    const questions = pendingQuestions(input)
    if (JSON.stringify(questions).length > MAX_QUESTION_CHARS) return null
    return { questions }
}

function delivered(raw: unknown, depth = 0): boolean {
    if (depth > 5) return false
    const value = record(json(raw))
    if (value.isError === true || value.type === 'error-text' || value.type === 'error-json') return false
    if (value.status === 'delivered') return true
    if ((value.type === 'json' || value.type === 'text') && 'value' in value) return delivered(value.value, depth + 1)
    if (value.structuredContent != null && delivered(value.structuredContent, depth + 1)) return true
    if (Array.isArray(value.content)) return value.content.some(part => record(part).type === 'text' && delivered(record(part).text, depth + 1))
    return false
}

// Saved tool rows are separate from assistant rows. Only the final user turn can hold a pending
// question; a later user message settles it even if its provider run failed. Match the result to
// the latest call, allowing the explanatory assistant text Rerun adds after a bare question.
export function findDesktopQuestion(rows: readonly QuestionRow[]): DesktopQuestion | null {
    let candidate: DesktopQuestion | null = null
    let acknowledged = false
    for (const row of rows) {
        if (row.role === 'user') { candidate = null; acknowledged = false; continue }
        const content = json(row.contentJson)
        const legacy = json(row.toolCallsJson)
        const parts = [...(Array.isArray(content) ? content : [content]), ...(Array.isArray(legacy) ? legacy : [])]
        for (const value of parts) {
            const part = record(value)
            const callId = part.toolCallId ?? part.id
            if (part.type === 'tool-result' || (row.role === 'tool' && (part.output !== undefined || part.result !== undefined))) {
                if (candidate && callId === candidate.toolCallId) acknowledged = part.isError !== true && delivered(part.output ?? part.result)
                continue
            }
            if (row.role !== 'assistant' || (part.type !== 'tool-call' && !part.toolName && !part.name && !record(part.function).name)) continue
            const rawName = part.toolName ?? part.name ?? record(part.function).name
            const name = typeof rawName === 'string' ? stripBridgePrefix(rawName) : ''
            if (name === 'skill_propose') continue
            candidate = null
            acknowledged = false
            if (name !== 'ask_user' || typeof callId !== 'string' || !callId || callId.length > 256 || !row.id || row.id.length > 256) continue
            const input = desktopQuestionInput(part.input ?? part.args ?? part.arguments ?? record(part.function).arguments)
            if (input) candidate = { sourceMessageId: row.id, toolCallId: callId, questions: input.questions, fingerprint: JSON.stringify(input.questions), requestedAt: row.createdAt ?? null }
        }
    }
    return acknowledged ? candidate : null
}
