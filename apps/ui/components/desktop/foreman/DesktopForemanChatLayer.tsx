'use client'

import { useDesktopLocale } from '../DesktopLocale'

import type { DesktopAnsweredQuestionRecap } from '@/lib/desktop/foreman/answered-question-recap'
import { DesktopForemanAnsweredQuestion } from './transcript/DesktopForemanAnsweredQuestion'
import type { ForemanHistoryPart } from './transcript/parts'
import { DesktopForemanHistoryMessage } from './transcript/DesktopForemanHistoryMessage'
import { DesktopForemanAnswerActions } from './DesktopForemanAnswerActions'

import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { DesktopDocumentLightbox } from '../document-attachments/DesktopDocumentLightbox'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { cn } from '@/lib/utils'
import { DesktopForemanDocsTool } from './docs/DesktopForemanDocsTool'
import type { UIMessage } from 'ai'
import {
    type DesktopForemanBuildProgressView,
    type DesktopForemanNextStep,
    type DesktopLeadSetupState,
    type DesktopPlanDecisionStatus,
    type DesktopTrustedPlanSnapshot,
    projectPlanCard,
} from '@/lib/desktop/foreman-client'
import { DesktopForemanWelcome } from './DesktopForemanWelcome'
import { DesktopPlanCard } from './plan/DesktopPlanCard'
import { DesktopForemanBuildProgress } from './DesktopForemanBuildProgress'
import { DesktopForemanNextSteps } from './DesktopForemanNextSteps'
import type { DesktopDocumentReference, MessageFeedbackRating } from '@rerun/contracts'

export type DesktopForemanMessage = {
    id: string
    role: 'user' | 'assistant' | 'system'
    text: string
    docs?: UIMessage['parts']
    history?: readonly ForemanHistoryPart[]
    answeredQuestions?: readonly DesktopAnsweredQuestionRecap[]
    documents?: readonly DesktopDocumentReference[]
}

export function DesktopForemanChatLayer({
    messages,
    attachmentsActive = true,
    streaming,
    restored,
    question,
    emptyWelcome,
    planSnapshot,
    decisionStatus,
    build,
    nextSteps,
    leadState,
    error,
    onConfirmPlan,
    onAskChanges,
    onRetryDecision,
    onResumeBuild,
    onStopBuild,
    buildBusy,
    onStartLead,
    onOpenCreated,
    onOpenCoworker,
    onOpenBox,
    answerFeedback,
    replyRetry,
    children,
    className,
}: {
    messages: DesktopForemanMessage[]
    attachmentsActive?: boolean
    streaming?: boolean
    restored: boolean
    question?: ReactNode
    emptyWelcome?: boolean
    planSnapshot: DesktopTrustedPlanSnapshot | null
    decisionStatus: DesktopPlanDecisionStatus
    build: DesktopForemanBuildProgressView | null
    nextSteps: DesktopForemanNextStep[]
    leadState: DesktopLeadSetupState
    live: boolean
    error?: string | null
    onConfirmPlan: () => void
    onAskChanges: () => void
    onRetryDecision?: () => void
    onResumeBuild?: () => void
    onStopBuild?: () => void
    buildBusy?: boolean
    onStartLead: (step: Extract<DesktopForemanNextStep, { kind: 'start_lead' }>) => void | Promise<void>
    onOpenCreated: (step: Extract<DesktopForemanNextStep, { kind: 'open_created' }>) => void
    onOpenCoworker?: (input: { agentId: string; sessionId: string | null }) => void
    onOpenBox?: (spaceId: string) => void
    /** Local thumbs for a restored saved answer; absent on read-only or still-live transcripts. */
    answerFeedback?: { ratingOf: (messageId: string) => MessageFeedbackRating | null; onRate: (messageId: string, rating: MessageFeedbackRating) => void; disabled?: boolean } | null
    replyRetry?: { review: (messageId: string) => void; disabled: boolean }
    children?: ReactNode
    className?: string
}) {
    const { t } = useDesktopLocale()
    const [preview, setPreview] = useState<{ messageId: string; index: number; trigger: HTMLButtonElement } | null>(null)
    const previewDocuments = preview && messages.find(message => message.id === preview.messageId)?.documents
    const plan = projectPlanCard(planSnapshot)
    const empty = messages.length === 0 && !error && !plan.view && !build && !question

    return (
        <div className={cn('pointer-events-auto relative flex min-h-0 w-full flex-1 flex-col', className)}>
            <AnimatePresence>
                {emptyWelcome && empty && restored && <DesktopForemanWelcome key="welcome" thinking={streaming} />}
            </AnimatePresence>
            {/* Match ForemanChatLayer: resize follows the latest message until the reader scrolls up. */}
            <Conversation className="min-h-0" aria-label={t('foreman.conversation')}>
                <ConversationContent scrollClassName="overflow-y-auto" className="mx-auto w-full max-w-xl justify-end gap-4 px-3 pb-5 pt-24 md:min-h-full">
                    {!restored && empty && (
                        <div aria-hidden className="flex flex-col gap-4">
                            <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
                            <div className="ml-auto h-16 w-40 animate-pulse rounded-lg bg-secondary" />
                            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
                        </div>
                    )}
                    {messages.map(message => (
                        <div
                            key={message.id}
                            className={cn(
                                'max-w-[95%] rounded-lg px-4 py-3 text-sm',
                                message.role === 'user' ? 'ml-auto bg-secondary' : 'bg-transparent text-foreground',
                            )}
                        >
                            {restored && message.role === 'user' && !!message.documents?.length && <div className="mb-1 flex flex-wrap gap-1">
                                {message.documents.map((document, index) => <Button key={document.attachmentId} type="button" variant="secondary" size="sm"
                                    onClick={event => setPreview({ messageId: message.id, index, trigger: event.currentTarget })}>{document.name}</Button>)}
                            </div>}
                            {restored && message.history ? <>
                                <DesktopForemanHistoryMessage history={message.history} />
                                <DesktopForemanAnsweredQuestion recaps={message.answeredQuestions ?? []} />
                                {message.role === 'assistant' && message.text.trim() && answerFeedback && (
                                    <DesktopForemanAnswerActions
                                        rating={answerFeedback.ratingOf(message.id)}
                                        disabled={!!streaming || answerFeedback.disabled}
                                        onRate={rating => answerFeedback.onRate(message.id, rating)}
                                        onReviewRetry={replyRetry && /^engine-[A-Za-z0-9_-]{1,128}$/.test(message.id) ? () => replyRetry.review(message.id) : undefined}
                                        retryDisabled={replyRetry?.disabled}
                                    />
                                )}
                            </> : <>
                                {message.text}
                                {message.docs?.map((part, index) => <DesktopForemanDocsTool key={index} part={part as import('ai').ToolUIPart} restored={restored} />)}
                            </>}
                        </div>
                    ))}
                    {question}
                    {plan.view && plan.revisionId && (
                        <DesktopPlanCard
                            plan={plan.view}
                            planRevisionId={plan.revisionId}
                            streaming={plan.streaming || !!streaming}
                            decision={plan.decision}
                            decisionStatus={decisionStatus}
                            onConfirm={onConfirmPlan}
                            onAskChanges={onAskChanges}
                            onRetryDecision={onRetryDecision}
                        />
                    )}
                    {build && (
                        <DesktopForemanBuildProgress build={build} onOpenCoworker={onOpenCoworker} onOpenBox={onOpenBox} onResume={onResumeBuild} onStop={onStopBuild} busy={buildBusy} />
                    )}
                    {nextSteps.length > 0 && !streaming && (
                        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
                            <DesktopForemanNextSteps
                                steps={nextSteps}
                                leadState={leadState}
                                onStartLead={onStartLead}
                                onOpenCreated={onOpenCreated}
                            />
                        </motion.div>
                    )}
                    {streaming && <p className="text-xs text-muted-foreground">{t('foreman.working')}</p>}
                    {error && (
                        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                            {error}
                        </div>
                    )}
                    {children}
                </ConversationContent>
                <ConversationScrollButton />
            </Conversation>
            {attachmentsActive && preview && previewDocuments && <DesktopDocumentLightbox attachments={previewDocuments} index={preview.index}
                onIndexChange={index => setPreview({ ...preview, index })} onClose={() => setPreview(null)} returnFocus={() => preview.trigger.focus()} />}
        </div>
    )
}
