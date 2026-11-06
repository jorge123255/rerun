'use client'
import { useEffect, useRef } from 'react'
import { DesktopQuestionCard, type DesktopQuestionCardProps } from '@/components/desktop/DesktopQuestionCard'
import { createQuestionAnswerAdapter } from '@/lib/desktop/chat-interactions/answer'
import { interactionKey, type ChatInteractionIdentity } from '@/lib/desktop/chat-interactions/identity'
export type ScopedQuestionCardProps = Omit<DesktopQuestionCardProps, 'onAnswer'> & {
    identity: ChatInteractionIdentity
    current(): ChatInteractionIdentity | null
    onAnswer(payload: Parameters<DesktopQuestionCardProps['onAnswer']>[0], signal: AbortSignal): Promise<void>
}
export function ScopedQuestionCard(props: ScopedQuestionCardProps) {
    return <QuestionCard key={interactionKey(props.identity)} {...props} />
}
function QuestionCard(props: ScopedQuestionCardProps) {
    const latest = useRef(props); latest.current = props
    const adapter = useRef<ReturnType<typeof createQuestionAnswerAdapter> | null>(null)
    useEffect(() => {
        const owned = createQuestionAnswerAdapter(props.identity, latest.current.question, {
            current: () => latest.current.current(),
            answer: (payload, signal) => latest.current.onAnswer(payload, signal),
        })
        adapter.current = owned
        return () => { owned.close(); if (adapter.current === owned) adapter.current = null }
    }, [])
    return <DesktopQuestionCard question={props.question} disabled={props.disabled} onAnswer={payload => {
        if (!adapter.current || latest.current.disabled) return Promise.reject(Error('This question is no longer current.'))
        return adapter.current.answer(payload)
    }} />
}
