import { desktopQuestionAnswerSchema, type DesktopQuestionAnswer, type DesktopPendingQuestion } from '../questions'
import { sameInteraction, type ChatInteractionIdentity } from './identity'

/** The existing canonical answer callback resolves only after verified receipt headers. */
export function createQuestionAnswerAdapter(identity: ChatInteractionIdentity, question: {
    id: string; messageId: string; toolCallId: string; attempt?: DesktopPendingQuestion['attempt']
}, ports: {
    current(): ChatInteractionIdentity | null
    answer(payload: DesktopQuestionAnswer, signal: AbortSignal): Promise<void>
}) {
    const lifetime = new AbortController()
    const intent = (p: DesktopQuestionAnswer) => JSON.stringify(p.action === 'cancel' ? { action: 'cancel' } : { action: 'answer', answers: p.answers.map(row => row.map(v => v.trim()).filter(Boolean)) })
    let selected = question.attempt ? { requestId: question.attempt.requestId, intent: intent({ ...question.attempt, questionId: question.id } as DesktopQuestionAnswer), accepted: false } : null
    let work: Promise<void> | null = null
    const current = () => !lifetime.signal.aborted && sameInteraction(identity, ports.current())
    return {
        answer(raw: DesktopQuestionAnswer): Promise<void> {
            const payload = desktopQuestionAnswerSchema.parse(raw)
            if (!current() || identity.messageId !== question.messageId || identity.toolCallId !== question.toolCallId || payload.questionId !== question.id) return Promise.reject(Error('This question is no longer current.'))
            const print = intent(payload)
            if (selected?.accepted) return Promise.reject(Error('This question already has an accepted answer.'))
            if (selected && (selected.requestId !== payload.requestId || selected.intent !== print)) return Promise.reject(Error('Retry the exact saved answer before changing it.'))
            if (work) return work
            selected ??= { requestId: payload.requestId, intent: print, accepted: false }
            const next = (async () => {
                await ports.answer(payload, lifetime.signal)
                selected!.accepted = true
                if (!current()) throw Error('The answer was accepted; its original chat is no longer active. Refresh that chat to view the receipt.')
            })()
            work = next
            void next.finally(() => { if (work === next) work = null }).catch(() => {})
            return next
        },
        close() { lifetime.abort() },
    }
}
