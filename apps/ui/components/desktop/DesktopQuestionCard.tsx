'use client'

import { QuestionForm, type QuestionAttachments } from '@rerun/ui/chat'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useDesktopLocale } from './DesktopLocale'
import { useDesktopQuestionVoice } from './voice/useDesktopQuestionVoice'
import { DesktopDocumentChips } from './document-attachments/DesktopDocumentChips'
import { useDesktopDocumentAttachments } from '@/lib/desktop/document-attachments/useDesktopDocumentAttachments'
import { QUESTION_DOCUMENT_POSITIONS, questionDocumentIndex, questionDocumentTabUid } from '@/lib/desktop/question-documents'
import type { DesktopPendingQuestion, DesktopQuestionAnswer, DesktopQuestionPayload } from '@/lib/desktop/questions'

export type DesktopQuestionCardProps = {
    question: DesktopPendingQuestion
    disabled?: boolean
    voiceSessionId?: string
    documentOwner?: { agentId: string; sessionId: string }
    onAnswer: (payload: DesktopQuestionAnswer) => Promise<void>
}

function QuestionCard({ question, disabled, voiceSessionId, onAnswer, files }: DesktopQuestionCardProps & {
    files?: ReturnType<typeof useDesktopDocumentAttachments>
}) {
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
            ...(payload.documents && { documents: payload.documents }),
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
    const { voice, error: voiceError } = useDesktopQuestionVoice(voiceSessionId, question.id, !locked && !attempt)
    const group = (index: number) => files?.attachments.filter(file => questionDocumentIndex(file.position) === index) ?? []
    const removeFiles = async (ids: string[]) => {
        for (const id of ids) if (!await files?.remove(id)) return false
        return true
    }
    const attachments: QuestionAttachments | undefined = files?.loaded ? {
        accept: '.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.log,.pdf,.wav,.mp3,.m4a,.ogg',
        onPick: (index, selected) => {
            const start = index * QUESTION_DOCUMENT_POSITIONS
            files.add(selected, { start, end: start + QUESTION_DOCUMENT_POSITIONS })
        },
        onClear: index => {
            const ids = group(index).map(file => file.attachmentId)
            return ids.length ? removeFiles(ids) : undefined
        },
        count: index => group(index).length,
        render: index => <DesktopDocumentChips attachments={group(index)} onRemove={files.remove} onRetry={files.retry} disabled={locked || files.busy > 0} />,
    } : undefined

    async function submit(answers: string[][]) {
        let documents
        try { documents = (await files?.settle())?.selection }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : t('question.failed'))
            throw cause
        }
        await send(identify({ action: 'answer', answers, ...(documents && { documents }) }))
    }

    async function dismiss() {
        if (files && (!files.loaded || !await removeFiles(files.attachments.map(file => file.attachmentId)))) {
            const cause = new Error('Wait for the question files to finish saving or remove them before dismissing.')
            setError(cause.message)
            throw cause
        }
        await send(identify({ action: 'cancel' }))
    }
    return <div className="space-y-2" aria-busy={status === 'sending'}>
        {attempt ? <div className="relative space-y-3 overflow-hidden rounded-lg border border-border bg-muted/30 p-3">
            {attempt.action === 'answer' ? question.questions.map((item, index) => (
                <div key={index} className="space-y-1.5">
                    <p className="text-sm font-medium leading-snug">{item.question}</p>
                    {attempt.answers[index]?.length
                        ? attempt.answers[index].map((answer, answerIndex) => <p key={answerIndex} className="whitespace-pre-wrap wrap-anywhere text-sm text-muted-foreground">{answer}</p>)
                        : !group(index).some(file => attempt.documents?.attachmentIds.includes(file.attachmentId)) && <p className="text-sm italic text-muted-foreground">{t('question.skipped')}</p>}
                    {group(index).filter(file => attempt.documents?.attachmentIds.includes(file.attachmentId)).map(file => (
                        <p key={file.attachmentId} className="text-xs text-muted-foreground">{file.name}</p>
                    ))}
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
        </div> : <QuestionForm inline labels={language.messages.questionForm} questions={question.questions} disabled={locked} voice={voice} attachments={attachments}
            onSubmit={answers => submit(answers.map(item => item.answers))}
            onCancel={dismiss} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {voiceError && <p role="alert" className="text-sm text-destructive">{voiceError}</p>}
        {files?.error && <p role="alert" className="text-sm text-destructive">{files.error}</p>}
        {files?.error && !files.loaded && <Button type="button" size="sm" variant="outline" disabled={locked}
            onClick={() => { void files.refresh().catch(() => {}) }}>{t('question.retryAttachments')}</Button>}
    </div>
}

function QuestionWithDocuments(props: DesktopQuestionCardProps & { documentOwner: NonNullable<DesktopQuestionCardProps['documentOwner']> }) {
    const files = useDesktopDocumentAttachments({ ...props.documentOwner, tabUid: questionDocumentTabUid(props.question.id),
        enabled: !props.disabled && !props.question.attempt })
    return <QuestionCard {...props} files={files} />
}

export function DesktopQuestionCard(props: DesktopQuestionCardProps) {
    // Scope local drafts and request IDs to the authoritative question, even if a parent reuses
    // this component when a different coworker or conversation becomes active.
    return props.documentOwner
        ? <QuestionWithDocuments key={props.question.id} {...props} documentOwner={props.documentOwner} />
        : <QuestionCard key={props.question.id} {...props} />
}
