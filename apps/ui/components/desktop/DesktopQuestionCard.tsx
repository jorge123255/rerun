'use client'

import { QuestionForm } from '@rerun/ui/chat'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useDesktopLocale } from './DesktopLocale'
import type { DesktopPendingQuestion, DesktopQuestionAnswer, DesktopQuestionPayload } from '@/lib/desktop/questions'

export type DesktopQuestionCardProps = {
    question: DesktopPendingQuestion
    disabled?: boolean
    onAnswer: (payload: DesktopQuestionAnswer) => Promise<void>
}

function QuestionCard({ question, disabled, onAnswer }: DesktopQuestionCardProps) {
    const { language, t } = useDesktopLocale()
    const latest = useRef({ question, disabled, onAnswer })
    latest.current = { question, disabled, onAnswer }
    const requests = useRef(new Map<string, string>())
    const claimed = useRef(false)
    const mounted = useRef(true)
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle')
    const [error, setError] = useState('')
    const [cancellation, setCancellation] = useState<DesktopQuestionAnswer | null>(null)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])

    function identify(payload: DesktopQuestionPayload): DesktopQuestionAnswer {
        // Match the server's canonical intent, including the order of multiple selections.
        const canonical: DesktopQuestionPayload = payload.action === 'cancel' ? payload : {
            action: 'answer', answers: payload.answers.map(values => values.map(value => value.trim()).filter(Boolean)),
        }
        const key = JSON.stringify(canonical)
        let requestId = requests.current.get(key)
        if (!requestId) {
            requestId = crypto.randomUUID()
            requests.current.set(key, requestId)
        }
        return { ...canonical, questionId: question.id, requestId }
    }

    async function send(payload: DesktopQuestionAnswer) {
        const current = latest.current
        if (!mounted.current || current.disabled || claimed.current || payload.questionId !== current.question.id) {
            throw new Error(t('question.unavailable'))
        }
        if (current.question.attempt && payload.requestId !== current.question.attempt.requestId) {
            throw new Error(t('question.retrySaved'))
        }
        // The original cancel callback is synchronous and cannot release its form latch on an
        // error. Keep its exact intent in the recovery view instead of reopening an empty form.
        claimed.current = true
        setStatus('sending')
        setError('')
        if (payload.action === 'cancel') setCancellation(payload)
        try {
            await current.onAnswer(payload)
            if (mounted.current) setStatus('sent')
        } catch (cause) {
            claimed.current = false
            if (mounted.current) {
                setStatus('idle')
                setError(cause instanceof Error ? cause.message : t('question.failed'))
            }
            // QuestionForm catches this and releases its own submission latch without losing
            // the selected answers. A retry of the same answers keeps the same request ID.
            throw cause
        }
    }

    const attempt: DesktopQuestionAnswer | null = question.attempt
        ? { ...question.attempt, questionId: question.id }
        : cancellation
    const locked = disabled || status !== 'idle'
    return <div className="space-y-2" aria-busy={status === 'sending'}>
        {attempt ? <div className="relative space-y-3 overflow-hidden rounded-lg border border-border bg-muted/30 p-3">
            {attempt.action === 'answer' ? question.questions.map((item, index) => (
                <div key={index} className="space-y-1.5">
                    <p className="text-sm font-medium leading-snug">{item.question}</p>
                    {attempt.answers[index]?.length
                        ? attempt.answers[index].map((answer, answerIndex) => <p key={answerIndex} className="whitespace-pre-wrap wrap-anywhere text-sm text-muted-foreground">{answer}</p>)
                        : <p className="text-sm italic text-muted-foreground">{t('question.skipped')}</p>}
                </div>
            )) : <p className="text-sm text-muted-foreground">{t('question.dismissed')}</p>}
            <p role="status" className="text-xs text-muted-foreground">{status === 'sent'
                ? attempt.action === 'cancel' ? t('question.sentCancellation') : t('question.sent')
                : status === 'sending'
                    ? attempt.action === 'cancel' ? t('question.sendingCancellation') : t('question.sending')
                    : attempt.action === 'cancel' ? t('question.retryCancellationHint') : t('question.retryHint')}</p>
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { void send(attempt).catch(() => {}) }}>
                {attempt.action === 'cancel' ? t('question.retryCancellation') : t('question.retry')}
            </Button>
        </div> : <QuestionForm inline labels={language.messages.questionForm} questions={question.questions} disabled={locked}
            onSubmit={answers => send(identify({ action: 'answer', answers: answers.map(item => item.answers) }))}
            onCancel={() => { void send(identify({ action: 'cancel' })).catch(() => {}) }} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
}

export function DesktopQuestionCard(props: DesktopQuestionCardProps) {
    // Scope local drafts and request IDs to the authoritative question, even if a parent reuses
    // this component when a different coworker or conversation becomes active.
    return <QuestionCard key={props.question.id} {...props} />
}
