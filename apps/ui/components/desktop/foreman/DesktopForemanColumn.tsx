'use client'

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ForemanAnchor, OrbActivity } from '@rerun/ui/foreman'
import { DesktopForemanDockLayout, DesktopParkedForeman, useDesktopForemanDockBinding } from './dock'
import { DEFAULT_DOCK_EXTRAS } from '@/lib/desktop/foreman-dock'
import type { ExactDockFeed } from '@/lib/desktop/foreman-dock/feed'
import type { ForemanPlacement } from '@/lib/foreman-layout'
import { useIsMobile as useMediaQuery } from '@rerun/ui/primitives/use-is-mobile'
import type { DesktopForemanActionPorts, DesktopForemanChatRef, DesktopForemanPlacement } from '@/lib/desktop/foreman-client'
import { DesktopForemanChatLayer, type DesktopForemanMessage } from './DesktopForemanChatLayer'
import { useDesktopForemanFeedback } from '@/lib/desktop/use-foreman-feedback'
import { DesktopForemanComposer } from './DesktopForemanComposer'
import { DesktopForemanHeader } from './DesktopForemanHeader'
import { DesktopForemanRoutines } from './DesktopForemanRoutines'
import { DesktopWorkspaceRoutines } from './routines/DesktopWorkspaceRoutines'
import { createDesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import { useMemo } from 'react'
import { DesktopPlanBoardPreview } from './plan/DesktopPlanBoardPreview'
import { projectPlanCard } from '@/lib/desktop/foreman-client'
import { useDesktopForemanUi } from './useDesktopForemanUi'
import type { DesktopForemanIntakeController } from '@/lib/desktop/foreman-intake'
import { DesktopForemanIntakeCard, DesktopForemanIntakeHeader } from './intake'
import { DesktopStarterPack } from './starter-pack'
import { DesktopStarterOfferCard } from './starter-pack/DesktopStarterOfferCard'
import type { DesktopLocalStarterDecision, DesktopStarterView } from '@/lib/desktop/foreman-client/starter'
import { DesktopQuestionCard } from '@/components/desktop/DesktopQuestionCard'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'
import type { DesktopTemplateIdentity } from '@/components/desktop/templates/types'
import { Button } from '@/components/ui/button'
import { RotateCwIcon } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopForemanAlternateReview, DesktopForemanAlternates } from './DesktopForemanAlternates'
import { useDesktopForemanAlternates } from './useDesktopForemanAlternates'
import { FOREMAN_AGENT_ID, foremanDocumentScope, type DesktopCoworkerCallTarget, type DesktopCoworkerMention } from '@rerun/contracts'
import type { MentionSkill } from '@/components/chat/MentionAutocomplete'
import { useDesktopMentionAutocomplete } from '../mentions/useDesktopMentionAutocomplete'
import { useDesktopDocumentAttachments } from '@/lib/desktop/document-attachments/useDesktopDocumentAttachments'
import { DesktopDocumentAttachmentControls } from '../document-attachments/DesktopDocumentAttachmentControls'
import { DesktopDocumentPicker } from '../document-attachments/DesktopDocumentPicker'
import { DesktopDelegationMount } from '../delegation/DesktopDelegationMount'
import { DesktopCoworkerCalls } from '../coworker-calls/DesktopCoworkerCalls'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'

function anchorOf(placement: DesktopForemanPlacement): ForemanAnchor {
    if (placement.mode === 'float') return 'float'
    return placement.side === 'left' ? 'dock-left' : 'dock-right'
}
const NO_MENTION_TARGETS: DesktopCoworkerCallTarget[] = []
const NO_SKILLS: MentionSkill[] = []
const NO_MENTIONS: DesktopCoworkerMention[] = []

export type DesktopForemanColumnProps = {
    chat: DesktopForemanChatRef
    ports: DesktopForemanActionPorts
    live: { runId: string } | null
    messages: DesktopForemanMessage[]
    mentionTargets?: DesktopCoworkerCallTarget[]
    onOpenCalledChat?: (target: DesktopCoworkerCallOpenTarget) => Promise<void>
    sessionId?: string
    pendingSend?: boolean
    retryAttachedMessage?: boolean
    imageModel?: boolean
    retrySnapshot?: string
    streaming?: boolean
    question?: DesktopPendingQuestion | null
    onAnswerQuestion?: (answer: DesktopQuestionAnswer) => Promise<void>
    agentNameOf: (agentId: string) => string
    orbState?: OrbActivity
    headerActions?: ReactNode
    /** Root mounts discoveries on the board; receives live overlay state. */
    renderBoardOverlay?: (input: { discoveries: import('@/lib/desktop/foreman-client').DesktopDiscoveriesState; live: boolean }) => ReactNode
    className?: string
    onClose?: () => void
    openOnMount?: boolean
    refreshKey?: string | number
    composerTrailing?: ReactNode
    sendDisabled?: boolean
    focusRequest?: string
    controlledOpen?: boolean
    hidden?: boolean
    centerOpen?: boolean
    dockFeed?: ExactDockFeed | null
    voiceSlot?: ReactNode
    intake?: DesktopForemanIntakeController
    intakeFinished?: boolean
    starter?: DesktopStarterView | null
    onStarterAnswer?: (input: DesktopLocalStarterDecision) => Promise<void>
    /** Opens the template library on one template's review; absent until root wires the seam. */
    onReviewTemplate?: (template: DesktopTemplateIdentity) => void
    onOpenChange?: (open: boolean) => void
    onLayout?: (layout: { scope: string; open: boolean; placement: ForemanPlacement; dragging: boolean; mobile: boolean }) => void
}

/**
 * Desktop Foreman column. Board stays visible behind/beside it; root mounts this package and
 * supplies conversation / model / voice / persistence adapters. Deliberate open/close only.
 */
export function DesktopForemanColumn({
    chat,
    ports,
    live,
    messages,
    mentionTargets,
    onOpenCalledChat,
    sessionId,
    pendingSend,
    retryAttachedMessage,
    imageModel,
    retrySnapshot,
    streaming,
    question, onAnswerQuestion,
    agentNameOf,
    orbState = 'idle',
    headerActions,
    renderBoardOverlay,
    className, onClose, openOnMount, refreshKey, composerTrailing, sendDisabled, focusRequest, controlledOpen, hidden, centerOpen, dockFeed, voiceSlot, intake, intakeFinished, starter, onStarterAnswer, onReviewTemplate, onOpenChange, onLayout,
}: DesktopForemanColumnProps) {
    const { t } = useDesktopLocale()
    const foreman = useDesktopForemanUi({ chat, ports, live, initialOpen: true, refreshKey, onClose })
    const savedAnswers = messages.some(message => message.role === 'assistant' && !!message.text.trim())
    const answerFeedback = useDesktopForemanFeedback(chat, !hidden && foreman.restored && savedAnswers)
    const opened = useRef(false)
    const column = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (openOnMount && foreman.restored && !opened.current) { opened.current = true; foreman.setOpen(true) }
    }, [openOnMount, foreman.restored, foreman.setOpen])
    const { ui } = foreman
    const composerScope = useRef({ chatId: chat.chatId, workspaceId: chat.workspaceId, draft: ui.draft })
    composerScope.current = { chatId: chat.chatId, workspaceId: chat.workspaceId, draft: ui.draft }
    const pendingStarter = !!starter && !starter.decision?.settled
    const onRoutines = ui.tab === 'routines'
    const [sendingDocuments, setSendingDocuments] = useState(false)
    const attachmentComposer = !!sessionId && !intake && !pendingStarter && !!intakeFinished && ui.open && !onRoutines
    const editAttachments = attachmentComposer && !hidden && !question && !streaming && !sendingDocuments
        && !pendingSend && !foreman.blocked && !sendDisabled && ui.decision.status !== 'pending' && foreman.restored
    const documents = useDesktopDocumentAttachments({ ...foremanDocumentScope(chat, sessionId ?? ''), load: attachmentComposer, enabled: editAttachments })
    const mentions = useDesktopMentionAutocomplete({
        targets: editAttachments && mentionTargets ? mentionTargets : NO_MENTION_TARGETS,
        skills: NO_SKILLS, requireCallable: false, text: ui.draft, mentions: ui.draftCoworkerMentions ?? NO_MENTIONS,
        onDraftChange: foreman.setDraft,
    })
    const alternates = useDesktopForemanAlternates({
        chat, snapshot: retrySnapshot, active: !!retrySnapshot && ui.open && !hidden && !onRoutines && !intake && foreman.restored,
        eligible: !!retrySnapshot && !streaming && !question && !pendingStarter && !foreman.blocked && ui.decision.status !== 'pending',
    })
    const { close: closeAlternates, open: alternatesOpen } = alternates
    const starterInFlight = useRef(false)
    const [starterBusy, setStarterBusy] = useState(false)
    const [starterError, setStarterError] = useState<{ offerId: string; message: string } | null>(null)
    const answerStarter = async (choice: DesktopLocalStarterDecision['choice'], fromComposer = false) => {
        if (!starter || !onStarterAnswer || starterInFlight.current || hidden || streaming || foreman.blocked) return
        const scope = composerScope.current
        starterInFlight.current = true
        setStarterBusy(true)
        setStarterError(null)
        try {
            await onStarterAnswer({ offerId: starter.offerId, intakeRequestId: starter.intakeRequestId, digest: starter.digest, choice })
            const current = composerScope.current
            const confirmedDraft = fromComposer || choice.kind === 'text' && scope.draft.trim() === choice.text.trim()
            if (confirmedDraft && current.chatId === scope.chatId && current.workspaceId === scope.workspaceId && current.draft === scope.draft) foreman.setDraft('')
        } catch (error) {
            setStarterError({ offerId: starter.offerId, message: error instanceof Error ? error.message : 'Could not save the starter choice.' })
        } finally { starterInFlight.current = false; setStarterBusy(false) }
    }
    const send = (text: string) => {
        if (pendingStarter) { void answerStarter({ kind: 'text', text }, true); return }
        if (!intake) {
            if (!attachmentComposer) { void foreman.sendMessage(text); return }
            setSendingDocuments(true)
            void foreman.sendMessage(text, async model => {
                if (!documents.attachments.length) return undefined
                if (!model) throw new Error(t('foreman.modelUnavailable'))
                if (!imageModel && documents.attachments.some(item => item.kind === 'image')) throw new Error('Image attachments need a ChatGPT / Codex model. Choose one before sending.')
                return (await documents.settle(model))?.selection
            }).then(async accepted => { if (accepted) await documents.refresh().catch(() => {}) })
                .finally(() => setSendingDocuments(false))
            return
        }
        const scope = composerScope.current
        void intake.sendOwn(text).then(confirmed => {
            const current = composerScope.current
            if (confirmed && current.chatId === scope.chatId && current.workspaceId === scope.workspaceId && current.draft === scope.draft) foreman.setDraft('')
        })
    }
    const triggerRef = useRef<HTMLElement | null>(null)
    const mobile = useMediaQuery('(max-width: 767px)')
    const wide = useMediaQuery('(min-width: 1024px)')
    const dockBinding = useDesktopForemanDockBinding({ chat, placement: ui.placement, dock: ui.dock ?? DEFAULT_DOCK_EXTRAS, setPlacement: foreman.setPlacement, setDock: foreman.setDock })
    const consumedFocus = useRef<string | undefined>(undefined)
    const changeOpen = useCallback((open: boolean) => {
        if (!open) consumedFocus.current = focusRequest
        foreman.setOpen(open)
        onOpenChange?.(open)
    }, [focusRequest, foreman.setOpen, onOpenChange])
    useEffect(() => {
        if (controlledOpen === undefined || !foreman.restored || controlledOpen === ui.open) return
        if (!controlledOpen) consumedFocus.current = focusRequest
        foreman.setOpen(controlledOpen)
    }, [controlledOpen, foreman.restored, ui.open, foreman.setOpen, focusRequest])
    useEffect(() => {
        if (!focusRequest || !foreman.restored || consumedFocus.current === focusRequest) return
        if (!ui.open) { changeOpen(true); return }
        if (ui.tab !== 'assistant') { foreman.setTab('assistant'); return }
        if (alternatesOpen) { closeAlternates(); return }
        let focused = false
        const focus = () => {
            const target = column.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(intake ? '[data-foreman-intake] input:not([disabled])' : 'textarea[data-desktop-foreman-composer]')
            if (!focused && target?.isConnected && !target.disabled && !target.closest('[inert]')) { focused = true; consumedFocus.current = focusRequest; target.focus({ preventScroll: true }); observer.disconnect() }
        }
        const observer = new MutationObserver(focus)
        observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['inert'] })
        queueMicrotask(focus)
        return () => { focused = true; observer.disconnect() }
    }, [focusRequest, foreman.restored, ui.open, ui.tab, foreman.setOpen, foreman.setTab, changeOpen, intake?.restored, alternatesOpen, closeAlternates])
    const routinesClient = useMemo(() => createDesktopWorkspaceRoutinesClient(), [])
    const plan = projectPlanCard(foreman.planSnapshot)
    const docked = ui.placement.mode === 'dock'
    // The rail takes the empty conversation's place instead of sitting under the welcome orb.
    const starterPack = Boolean(!intakeFinished && !starter && onReviewTemplate && foreman.restored && messages.length === 0 && !plan.view && !foreman.build)
    return (
        <>
        <DesktopForemanDockLayout scope={dockBinding.scope} open={ui.open} hidden={hidden}
            placement={dockBinding.placement} dock={dockBinding.dock} onPlacement={dockBinding.onPlacement} onDock={dockBinding.onDock}
            onClose={() => changeOpen(false)} returnFocus={() => triggerRef.current} onLayout={onLayout}>
            {header => <div ref={column} className="relative flex h-full min-h-0 flex-col">
                <DesktopForemanHeader
                    onDragPointerDown={header.onPointerDown}
                    anchor={anchorOf(dockBinding.placement)}
                    orbState={orbState}
                    open={ui.open}
                    tab={ui.tab}
                    onTabChange={foreman.setTab}
                    onClose={() => changeOpen(false)}
                    actions={<>
                        {headerActions}
                        {retrySnapshot && !onRoutines && !intake && alternates.items.length > 0 && !alternates.open &&
                            <Button type="button" size="icon-xs" variant="ghost" aria-label={t('foreman.alternates.title')}
                                title={t('foreman.alternates.title')} onClick={alternates.openList}><RotateCwIcon /></Button>}
                    </>}
                />
                <div className={onRoutines || alternates.open ? 'hidden' : 'contents'}>
                    {intake ? <>
                        <div className="relative flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-3 py-6">
                            <DesktopForemanIntakeHeader intake={intake} />
                        </div>
                        <div className="shrink-0 px-3 pb-3"><DesktopForemanIntakeCard intake={intake} autoFocus={ui.open && !hidden} /></div>
                    </> : <>
                    <DesktopForemanChatLayer
                        messages={messages}
                        attachmentsActive={ui.open && !hidden && !onRoutines && !alternates.open}
                        streaming={streaming}
                        restored={foreman.restored}
                        question={foreman.restored && !streaming && question && onAnswerQuestion
                            ? <DesktopQuestionCard question={question} disabled={hidden || !!foreman.blocked} onAnswer={onAnswerQuestion} /> : null}
                        emptyWelcome={!starterPack && !pendingStarter}
                        planSnapshot={foreman.planSnapshot}
                        decisionStatus={ui.decision}
                        build={foreman.build}
                        nextSteps={foreman.nextSteps}
                        leadState={foreman.leadState}
                        live={foreman.live}
                        error={(starterError?.offerId === starter?.offerId ? starterError?.message : null) || alternates.error || foreman.error || (foreman.blocked ? `Blocked: ${foreman.blocked.replaceAll('_', ' ')}` : null)}
                        onConfirmPlan={foreman.confirmPlan}
                        onAskChanges={() => foreman.askChanges()}
                        onRetryDecision={foreman.retryDecision}
                        onResumeBuild={() => void foreman.actOnBuild('resume')}
                        onStopBuild={() => void foreman.actOnBuild('stop')}
                        buildBusy={foreman.buildBusy}
                        onStartLead={foreman.startLead}
                        onOpenCreated={step => foreman.navigate({ kind: 'open_coworker', agentId: step.agentId, sessionId: step.sessionId })}
                        onOpenCoworker={input => foreman.navigate({ kind: 'open_coworker', agentId: input.agentId, sessionId: input.sessionId })}
                        onOpenBox={spaceId => foreman.navigate({ kind: 'open_box', spaceId })}
                        answerFeedback={{ ratingOf: answerFeedback.ratingOf, onRate: answerFeedback.rate, disabled: hidden }}
                        replyRetry={retrySnapshot ? { review: id => void alternates.reviewReply(id),
                            disabled: !!streaming || !!question || pendingStarter || !!foreman.blocked || alternates.busy || ui.decision.status === 'pending' } : undefined}
                        className="min-h-0 flex-1"
                    >
                        {sessionId && ui.open && !hidden && !onRoutines && !alternates.open && foreman.restored &&
                            <Fragment key={`${chat.workspaceId}:${chat.chatId}`}>
                                <DesktopDelegationMount scope="foreman" sessionId={chat.chatId}
                                    agentId={FOREMAN_AGENT_ID} followLive={!!live} stopRunId={live?.runId ?? null} />
                                <DesktopCoworkerCalls agentId={FOREMAN_AGENT_ID} sessionId={chat.chatId} fallback={null}
                                    currentRunActive={!!live} onOpenTarget={onOpenCalledChat} />
                            </Fragment>}
                        {starterPack && onReviewTemplate && <DesktopStarterPack
                            workspaceId={chat.workspaceId}
                            active={ui.open && !hidden}
                            onReviewTemplate={onReviewTemplate}
                        />}
                        {starter && onStarterAnswer && foreman.restored && <DesktopStarterOfferCard key={starter.offerId} offer={starter}
                            disabled={!!hidden || !!streaming || starterBusy || !!foreman.blocked}
                            onAnswer={choice => { void answerStarter(choice) }} onStop={() => { void foreman.stop() }} />}
                    </DesktopForemanChatLayer>
                    </>}
                    <DesktopForemanComposer
                        mentions={editAttachments && !alternates.open ? mentions : undefined}
                        trailing={intake || pendingStarter ? undefined : composerTrailing}
                        controls={intake || pendingStarter || !ui.open ? undefined : <>
                            {attachmentComposer && <DesktopDocumentPicker disabled={!editAttachments || !documents.loaded} onFiles={documents.add} />}
                            {voiceSlot}
                        </>}
                        attachments={attachmentComposer && (documents.attachments.length > 0 || documents.error)
                            ? <DesktopDocumentAttachmentControls controller={documents} disabled={!editAttachments} /> : undefined}
                        hasAttachments={attachmentComposer && (documents.attachments.length > 0 || retryAttachedMessage)}
                        onFiles={editAttachments && documents.loaded ? documents.add : undefined}
                        placeholder={intake || pendingStarter ? t('foreman.ownEntryPlaceholder') : undefined}
                        maxLength={intake || pendingStarter ? 4000 : undefined}
                        draft={ui.draft}
                        onDraftChange={foreman.setDraft}
                        busy={!!streaming}
                        sendDisabled={sendDisabled || attachmentComposer && (sendingDocuments || !pendingSend && (!documents.loaded || documents.busy > 0))}
                        disabled={!!question || !foreman.restored || !!foreman.blocked || ui.decision.status === 'pending'
                            || pendingStarter && (!onStarterAnswer || starterBusy || !!starter?.decision)
                            || Boolean(intake && (!intake.restored || intake.submitting || intake.quitting || intake.conflicted))}
                        onSend={send}
                        onStop={() => void foreman.stop()}
                    />
                </div>
                {!onRoutines && alternates.open && <DesktopForemanAlternates ui={alternates}
                    sourceText={id => messages.find(message => message.id === id)?.text} />}
                <DesktopForemanAlternateReview ui={alternates} />
                {onRoutines && (
                    <DesktopWorkspaceRoutines
                        key={`${chat.workspaceId}:${chat.chatId}`}
                        client={routinesClient}
                        active={ui.open && !hidden}
                        onOpenChat={target => foreman.navigate({ kind: 'open_coworker', agentId: target.agentId, sessionId: target.sessionId })}
                        docked={docked}
                        agentNameOf={agentNameOf}
                        className="min-h-0 flex-1 pt-24"
                    />
                )}
            </div>}
        </DesktopForemanDockLayout>
        <DesktopParkedForeman chat={chat} open={ui.open} hidden={hidden} centerOpen={centerOpen} mobile={mobile} wide={wide}
            corner={dockBinding.placement.mode === 'float' ? dockBinding.placement.corner : dockBinding.dock.orbCorner}
            onCorner={corner => { dockBinding.onDock({ ...dockBinding.dock, orbCorner: corner }); if (dockBinding.placement.mode === 'float') dockBinding.onPlacement({ ...dockBinding.placement, corner }) }}
            onOpen={() => changeOpen(true)} feed={dockFeed ?? null} voiceSlot={ui.open ? undefined : voiceSlot} onTrigger={node => { triggerRef.current = node }} />
            {/* Board-side plan preview host: root may also mirror plan via setPlanPreview. */}
            {renderBoardOverlay?.({ discoveries: foreman.discoveries, live: foreman.live })}
            {plan.view && (
                <div className="pointer-events-none absolute inset-0 -z-10 hidden opacity-0" aria-hidden>
                    <DesktopPlanBoardPreview plan={plan.view} />
                </div>
            )}
        </>
    )
}
