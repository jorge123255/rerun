'use client'

import { CompactionStep } from '@/components/chat/CompactionBlock'
import { ChatActivityPresentation } from '@/components/chat/ChatActivityPresentation'
import { LOADER_ORB_SIZE, Orb } from '@rerun/ui/foreman'
import type { DesktopCompactionReceipt } from '@rerun/contracts'
import { useDesktopLocale } from '../DesktopLocale'

import type { DesktopSavedChatDecision } from '@/lib/desktop/saved-chat-decision'
import { DesktopSavedDecisionReceipt } from '../DesktopSavedDecisionReceipt'
import type { ForemanHistoryPart } from './transcript/parts'
import { DesktopForemanHistoryMessage, DesktopForemanMarkdown } from './transcript/DesktopForemanHistoryMessage'
import { DesktopForemanAnswerActions } from './DesktopForemanAnswerActions'

import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { DesktopConversationFind } from '../DesktopConversationFind'
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
import type { DesktopCoworkerMention, DesktopDocumentReference, MessageFeedbackRating } from '@rerun/contracts'
import { DesktopSelectedMentionText } from '../mentions/DesktopSelectedMentionText'

export type DesktopForemanMessage = {
    id: string
    role: 'user' | 'assistant' | 'system'
    text: string
    sourceRunId?: string
    docs?: UIMessage['parts']
    history?: readonly ForemanHistoryPart[]
    savedDecision?: DesktopSavedChatDecision
    compaction?: DesktopCompactionReceipt
    documents?: readonly DesktopDocumentReference[]
    coworkerMentions?: readonly DesktopCoworkerMention[]
}

function RunCardsSlot({ runId, register }: { runId: string; register: (runId: string, node: HTMLDivElement | null) => void }) {
    const ref = useCallback((node: HTMLDivElement | null) => register(runId, node), [register, runId])
    return <div className="flex min-w-0 flex-col gap-3 empty:hidden" ref={ref} />
}

function ForemanTranscriptFind({ transcript, hidden, onClose }: {
    transcript: RefObject<HTMLDivElement | null>
    hidden?: boolean
    onClose?: () => void
}) {
    const [open, setOpen] = useState(false)
    useEffect(() => {
        const find = () => setOpen(true)
        window.addEventListener('rerun-desktop-conversation-find', find)
        return () => window.removeEventListener('rerun-desktop-conversation-find', find)
    }, [])
    return <DesktopConversationFind open={open && !hidden} transcript={transcript} onOpenChange={next => {
        setOpen(next)
        if (!next) onClose?.()
    }} />
}

export function DesktopForemanChatLayer({
    messages,
    active = true,
    findScope, findHidden, onCloseFind,
    streaming,
    liveReply,
    writing,
    restored,
    question,
    emptyWelcome,
    planSnapshot,
    decisionStatus,
    build,
    nextSteps,
    leadState,
    error,
    runNotice,
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
    renderChildWork,
    children,
    className,
}: {
    messages: DesktopForemanMessage[]
    active?: boolean
    findScope?: string
    findHidden?: boolean
    onCloseFind?: () => void
    streaming?: boolean
    liveReply?: string
    writing?: boolean
    restored: boolean
    question?: ReactNode
    emptyWelcome?: boolean
    planSnapshot: DesktopTrustedPlanSnapshot | null
    decisionStatus: DesktopPlanDecisionStatus
    build: DesktopForemanBuildProgressView | null
    nextSteps: DesktopForemanNextStep[]
    leadState: DesktopLeadSetupState
    error?: string | null
    runNotice?: ReactNode
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
    renderChildWork?: (slots: ReadonlyMap<string, HTMLDivElement>) => ReactNode
    children?: ReactNode
    className?: string
}) {
    const { t } = useDesktopLocale()
    const transcript = useRef<HTMLDivElement>(null)
    const [preview, setPreview] = useState<{ messageId: string; index: number; trigger: HTMLButtonElement } | null>(null)
    const [runSlots, setRunSlots] = useState<ReadonlyMap<string, HTMLDivElement>>(() => new Map())
    const register = useCallback((runId: string, node: HTMLDivElement | null) => {
        setRunSlots(previous => {
            if ((previous.get(runId) ?? null) === node) return previous
            const next = new Map(previous)
            if (node) next.set(runId, node)
            else next.delete(runId)
            return next
        })
    }, [])
    const previewDocuments = preview && messages.find(message => message.id === preview.messageId)?.documents
    const plan = projectPlanCard(planSnapshot)
    const previewReply = active && restored && streaming ? liveReply : undefined
    const empty = messages.length === 0 && !previewReply && !error && !runNotice && !plan.view && !build && !question

    return (
        <div className={cn('pointer-events-auto relative flex min-h-0 w-full flex-1 flex-col', className)}>
            <AnimatePresence>
                {emptyWelcome && empty && restored && <DesktopForemanWelcome key="welcome" thinking={streaming} />}
            </AnimatePresence>
            {/* Match ForemanChatLayer: resize follows the latest message until the reader scrolls up. */}
            <Conversation className="min-h-0" aria-label={t('foreman.conversation')}>
                <ConversationContent scrollClassName="overflow-y-auto" className="mx-auto w-full max-w-xl justify-end gap-4 px-3 pb-5 pt-24 md:min-h-full">
                    {findScope && <ForemanTranscriptFind key={findScope} transcript={transcript} hidden={findHidden} onClose={onCloseFind} />}
                    {!restored && empty && (
                        <div aria-hidden className="flex flex-col gap-4">
                            <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
                            <div className="ml-auto h-16 w-40 animate-pulse rounded-lg bg-secondary" />
                            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
                        </div>
                    )}
                    <div ref={transcript} className="contents">{messages.map(message => (
                        <Fragment key={message.id}>
                        {restored && message.role === 'user' && message.savedDecision ? (
                            <div data-chat-find-message className="contents">
                                <DesktopSavedDecisionReceipt decision={message.savedDecision} documents={message.documents ?? []}
                                    onOpenDocument={active ? (index, trigger) => setPreview({ messageId: message.id, index, trigger }) : undefined} />
                            </div>
                        ) : <div
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
                                {message.role === 'user' && message.coworkerMentions?.length
                                    ? <div data-chat-find-message className="whitespace-pre-wrap wrap-anywhere"><DesktopSelectedMentionText text={message.text} metadata={message} /></div>
                                    : <DesktopForemanHistoryMessage history={message.history} userLinks={message.role === 'user'} />}
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
                                <div data-chat-find-message className="contents">{message.role === 'user'
                                    ? <DesktopSelectedMentionText text={message.text} metadata={message} /> : message.text}</div>
                                {message.docs?.map((part, index) => <DesktopForemanDocsTool key={index} part={part as import('ai').ToolUIPart} restored={restored} />)}
                            </>}
                        </div>}
                        {restored && message.role === 'user' && message.compaction && <CompactionStep data={message.compaction} />}
                        {renderChildWork && restored && message.role === 'user' && message.sourceRunId &&
                            <RunCardsSlot runId={message.sourceRunId} register={register} />}
                        </Fragment>
                    ))}</div>
                    {previewReply && <div data-foreman-live-reply data-chat-find-ignore className="max-w-[95%] rounded-lg px-4 py-3 text-sm text-foreground">
                        <DesktopForemanMarkdown text={previewReply} streaming />
                    </div>}
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
                    {active && restored && streaming && (
                        <ChatActivityPresentation activity={writing ? t('chatActivity.writing') : null}
                            labels={[t('chatActivity.thinking'), t('chatActivity.processing'), t('chatActivity.crafting')]}
                            indicator={<Orb size={LOADER_ORB_SIZE} state={writing ? 'speaking' : 'thinking'} facing="right" className="shrink-0" />}
                            announce />
                    )}
                    {error && (
                        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                            {error}
                        </div>
                    )}
                    {renderChildWork?.(runSlots)}
                    {runNotice}
                    {children}
                </ConversationContent>
                <ConversationScrollButton />
            </Conversation>
            {active && preview && previewDocuments && <DesktopDocumentLightbox attachments={previewDocuments} index={preview.index}
                onIndexChange={index => setPreview({ ...preview, index })} onClose={() => setPreview(null)} returnFocus={() => preview.trigger.focus()} />}
        </div>
    )
}
