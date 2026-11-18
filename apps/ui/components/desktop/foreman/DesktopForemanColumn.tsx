'use client'

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { OrbActivity } from '@rerun/ui/foreman'
import { DesktopForemanDockLayout, DesktopParkedForeman, useDesktopForemanDockBinding } from './dock'
import { DEFAULT_DOCK_EXTRAS } from '@/lib/desktop/foreman-dock'
import type { ExactDockFeed } from '@/lib/desktop/foreman-dock/feed'
import type { ForemanPlacement } from '@/lib/foreman-layout'
import { useIsMobile as useMediaQuery } from '@rerun/ui/primitives/use-is-mobile'
import type { DesktopForemanActionPorts, DesktopForemanChatRef } from '@/lib/desktop/foreman-client'
import type { DesktopForemanLiveReply } from '@/lib/desktop/foreman/live-reply'
import { DesktopForemanChatLayer, type DesktopForemanMessage } from './DesktopForemanChatLayer'
import type { DesktopForemanGeneralThread } from './DesktopForemanConversations'
import { useDesktopForemanFeedback } from '@/lib/desktop/use-foreman-feedback'
import { desktopForemanSpeechScope, desktopSpeechKey, desktopSpeechPlayer, useDesktopSpeechPlayer, useDesktopSpeechSettings } from '@/lib/desktop/speech-player'
import { DesktopForemanOrbStage, desktopOrbMood } from '../panel-motion/DesktopForemanOrb'
import { DesktopArrive, useDesktopLiveGate } from '../panel-motion/DesktopArrive'
import { DesktopForemanComposer } from './DesktopForemanComposer'
import { DesktopForemanTeamWelcome } from './DesktopForemanTeamWelcome'
import { DesktopForemanHeader } from './DesktopForemanHeader'
import { DesktopForemanMove, desktopForemanAnchorOf } from './DesktopForemanMove'
import { DesktopForemanRoutines } from './DesktopForemanRoutines'
import { DesktopForemanNameMark, DesktopForemanTopBar, type DesktopForemanFramedBar } from './DesktopForemanTopBar'
import { DesktopForemanDetails } from './DesktopForemanDetails'
import { DESKTOP_DETAILS_ROOM, DesktopDetailsColumn } from '../simple/DesktopDetailsColumn'
import { FloatingPill } from '@/components/agent/sheet/floating'
import { setDesktopDetailsWanted, useDesktopDetailsWanted } from '@/lib/desktop/simple-details'
import { DesktopWorkspaceRoutines } from './routines/DesktopWorkspaceRoutines'
import { createDesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import { useMemo } from 'react'
import { DesktopPlanBoardPreview } from './plan/DesktopPlanBoardPreview'
import { projectPlanCard } from '@/lib/desktop/foreman-client'
import { useDesktopForemanUi } from './useDesktopForemanUi'
import type { DesktopForemanIntakeController } from '@/lib/desktop/foreman-intake'
import { DesktopForemanIntakeCard, DesktopForemanIntakeHeader, DesktopIntakeGithubProjects, DesktopIntakeSiteProfile } from './intake'
import { useDesktopIntakeGithub } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'
import { DesktopForemanGithubProjects } from './DesktopForemanGithubProjects'
import { DesktopForemanTeamChanges } from './DesktopForemanTeamChanges'
import { DesktopStarterPack } from './starter-pack'
import { DesktopStarterOfferCard } from './starter-pack/DesktopStarterOfferCard'
import type { DesktopLocalStarterDecision, DesktopStarterView } from '@/lib/desktop/foreman-client/starter'
import { DesktopApprovalCard } from '@/components/desktop/DesktopApprovalCard'
import type { DesktopApprovalAnswer, DesktopPendingApproval } from '@/lib/desktop/approvals'
import { DesktopQuestionCard } from '@/components/desktop/DesktopQuestionCard'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'
import type { DesktopTemplateIdentity } from '@/components/desktop/templates/types'
import { Button } from '@/components/ui/button'
import { ChevronDownIcon, RotateCwIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { DesktopForemanAlternateReview, DesktopForemanAlternates } from './DesktopForemanAlternates'
import { useDesktopForemanAlternates } from './useDesktopForemanAlternates'
import { FOREMAN_AGENT_ID, foremanDocumentScope, githubRepositoryLinksInText, trimDesktopCoworkerMentions, type DesktopCoworkerCallTarget, type DesktopCoworkerMention, type TeamAgent } from '@rerun/contracts'
import type { DesktopForemanPersistedUi } from '@/lib/desktop/foreman-client/persistence'
import type { MentionSkill } from '@/components/chat/MentionAutocomplete'
import { useDesktopMentionAutocomplete } from '../mentions/useDesktopMentionAutocomplete'
import { useDesktopDocumentAttachments } from '@/lib/desktop/document-attachments/useDesktopDocumentAttachments'
import { DesktopDocumentAttachmentControls } from '../document-attachments/DesktopDocumentAttachmentControls'
import { DesktopDocumentPicker } from '../document-attachments/DesktopDocumentPicker'
import { DesktopDelegationMount } from '../delegation/DesktopDelegationMount'
import { DesktopCoworkerCalls } from '../coworker-calls/DesktopCoworkerCalls'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'

const NO_MENTION_TARGETS: DesktopCoworkerCallTarget[] = []
const NO_SKILLS: MentionSkill[] = []
const NO_MENTIONS: DesktopCoworkerMention[] = []

export type DesktopForemanColumnProps = {
    chat: DesktopForemanChatRef
    ports: DesktopForemanActionPorts
    live: { runId: string } | null
    messages: DesktopForemanMessage[]
    mentionTargets?: DesktopCoworkerCallTarget[]
    team?: TeamAgent[]
    firstName?: string
    nextRoutine?: { name: string; at: number }
    routineNow?: number
    onOpenCalledChat?: (target: DesktopCoworkerCallOpenTarget) => Promise<void>
    callSources?: readonly { callId: string; runId: string }[]
    sessionId?: string
    pendingSend?: DesktopForemanPersistedUi['pendingSend']
    onRetryPendingSend?: (requestId: string) => Promise<boolean>
    imageModel?: boolean
    retrySnapshot?: string
    streaming?: boolean
    liveReply?: DesktopForemanLiveReply
    approval?: DesktopPendingApproval | null
    onDecideApproval?: (answer: DesktopApprovalAnswer) => Promise<void>
    question?: DesktopPendingQuestion | null
    onAnswerQuestion?: (answer: DesktopQuestionAnswer) => Promise<void>
    agentNameOf: (agentId: string) => string
    orbState?: OrbActivity
    headerActions?: ReactNode
    /** The thread on screen, on its own row under the tabs. */
    headerCrumb?: ReactNode
    /** What the header shows in the Simple view's middle, where the column takes a coworker's frame. */
    framedBar?: DesktopForemanFramedBar
    /** General's saved tasks and the way into one, drawn as branches in the transcript. */
    threads?: readonly DesktopForemanGeneralThread[]
    onOpenThread?: (thread: DesktopForemanGeneralThread) => void
    runNotice?: ReactNode
    /** Root mounts discoveries on the board; receives live overlay state. */
    renderBoardOverlay?: (input: { discoveries: import('@/lib/desktop/foreman-client').DesktopDiscoveriesState; live: boolean }) => ReactNode
    className?: string
    onClose?: () => void
    openOnMount?: boolean
    refreshKey?: string | number
    composerTrailing?: ReactNode
    sendDisabled?: boolean
    focusRequest?: string
    /** The message a new task was opened with: it goes into the composer and, unless held back, is sent once. */
    firstSend?: { id: string; text: string; coworkerMentions?: DesktopCoworkerMention[]; send: boolean }
    controlledOpen?: boolean
    hidden?: boolean
    fill?: boolean
    centerOpen?: boolean
    findEnabled?: boolean
    dockFeed?: ExactDockFeed | null
    voiceSlot?: ReactNode
    /** The voice slot shows its microphone: it stands where the send button is while the composer is empty. */
    voiceMic?: boolean
    /** The microphone is open and recording the person's voice: the orb shows it. */
    voiceRecording?: boolean
    intake?: DesktopForemanIntakeController
    intakeFinished?: boolean
    separateConversation?: boolean
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
    mentionTargets, team, firstName = '', nextRoutine, routineNow,
    onOpenCalledChat,
    callSources,
    sessionId,
    pendingSend,
    onRetryPendingSend,
    imageModel,
    retrySnapshot,
    streaming,
    liveReply,
    approval, onDecideApproval, question, onAnswerQuestion,
    agentNameOf,
    orbState = 'idle',
    headerActions,
    headerCrumb, framedBar, threads, onOpenThread,
    runNotice,
    renderBoardOverlay,
    className, onClose, openOnMount, refreshKey, composerTrailing, sendDisabled, focusRequest, firstSend, controlledOpen, hidden, fill, centerOpen, findEnabled, dockFeed, voiceSlot, voiceMic, voiceRecording, intake, intakeFinished, separateConversation, starter, onStarterAnswer, onReviewTemplate, onOpenChange, onLayout,
}: DesktopForemanColumnProps) {
    const { t } = useDesktopLocale()
    const foreman = useDesktopForemanUi({ chat, ports, live, initialOpen: true, refreshKey, onClose })
    const savedAnswers = messages.some(message => message.role === 'assistant' && !!message.text.trim())
    const answerFeedback = useDesktopForemanFeedback(chat, !hidden && foreman.restored && savedAnswers)
    const opened = useRef(false)
    const column = useRef<HTMLDivElement>(null)
    // The owner's GitHub projects, asked beside the website in the first intake question. Nothing is read while the questions are closed or hidden.
    // In the conversation itself they are the repositories linked in its messages, read on the server side when a message is sent.
    // Nothing is asked for a conversation that linked none, so an unsaved new task stays unsaved.
    const linkedMessages = intake ? 0 : messages.reduce((count, message) => count + (message.role === 'user' && githubRepositoryLinksInText(message.text).length ? 1 : 0), 0)
    const github = useDesktopIntakeGithub({ chat, active: (!!intake || linkedMessages > 0) && foreman.ui.open && !hidden })
    const reloadGithub = github.reload
    useEffect(() => { if (linkedMessages > 0) reloadGithub() }, [linkedMessages, streaming, reloadGithub])
    // The model's description of the projects follows the fast read by some seconds: look again until it is in.
    const describing = !intake && linkedMessages > 0 && github.record?.inference === 'none' && !!github.record.inferenceNote
    useEffect(() => {
        if (!describing) return
        let left = 12
        const timer = setInterval(() => { if (left-- <= 0) clearInterval(timer); else reloadGithub() }, 5_000)
        return () => clearInterval(timer)
    }, [describing, reloadGithub])
    useEffect(() => {
        if (openOnMount && foreman.restored && !opened.current) { opened.current = true; foreman.setOpen(true) }
    }, [openOnMount, foreman.restored, foreman.setOpen])
    const { ui } = foreman
    const draftRepositories = githubRepositoryLinksInText(ui.draft ?? '').length
    // Replies read aloud: offered when an ElevenLabs key is saved; the voice stops when this conversation is left or closed.
    const speech = useDesktopSpeechSettings(!hidden)
    useEffect(() => {
        if (hidden || !ui.open) return
        const prefix = desktopSpeechKey(desktopForemanSpeechScope(chat.workspaceId), chat.chatId, '')
        return () => desktopSpeechPlayer.stopWithin(prefix)
    }, [chat.workspaceId, chat.chatId, hidden, ui.open])
    const composerScope = useRef({ chatId: chat.chatId, workspaceId: chat.workspaceId, draft: ui.draft, mentions: ui.draftCoworkerMentions })
    composerScope.current = { chatId: chat.chatId, workspaceId: chat.workspaceId, draft: ui.draft, mentions: ui.draftCoworkerMentions }
    const pendingStarter = !!starter && !starter.decision?.settled
    const mobile = useMediaQuery('(max-width: 767px)')
    const wide = useMediaQuery('(min-width: 1280px)')
    // In the Simple view's middle the Chief of Staff takes the frame a coworker's chat has (upstream #316).
    const framed = !!fill && !mobile && !!framedBar
    // There the routines are not in a tab over the chat.
    const onRoutines = ui.tab === 'routines' && !framed
    // The column beside the chat: open or closed as a coworker's card was left, and kept from one to the other.
    const detailsWanted = useDesktopDetailsWanted()
    const detailsOpen = framed && detailsWanted
    // Mounted by the first opening and kept, so opening it again draws nothing new.
    const [detailsMounted, setDetailsMounted] = useState(false)
    if (detailsOpen && !detailsMounted) setDetailsMounted(true)
    const [sendingDocuments, setSendingDocuments] = useState(false)
    const [retryingSend, setRetryingSend] = useState(false)
    const retryInFlight = useRef(false)
    const [retrySendError, setRetrySendError] = useState<{ requestId: string; text: string } | null>(null)
    const attachmentComposer = !!sessionId && !intake && !pendingStarter && !!intakeFinished && ui.open && !onRoutines
    const pendingRequest = !!(question || approval)
    // The orb's one mood: recording the person, reading a reply aloud, thinking or writing, or waiting on them.
    const spoken = useDesktopSpeechPlayer()
    const readingAloud = !hidden && spoken.phase === 'playing' && !!spoken.key?.startsWith(desktopSpeechKey(desktopForemanSpeechScope(chat.workspaceId), chat.chatId, ''))
    const orbMood = desktopOrbMood({ activity: orbState, recording: !!voiceRecording && !hidden, reading: readingAloud, waiting: pendingRequest && !streaming && !hidden })
    // A request that was there when the conversation was restored is drawn settled; one that comes after slides in.
    const arrivesLive = useDesktopLiveGate(`${chat.workspaceId}:${chat.chatId}`, foreman.restored && ui.open && !hidden)
    const retryDisabled = hidden || streaming || pendingRequest || pendingStarter || !!intake || sendDisabled
        || !foreman.restored || !!foreman.blocked || ui.decision.status === 'pending'
    const editAttachments = attachmentComposer && !hidden && !pendingRequest && !streaming && !sendingDocuments
        && !pendingSend && !foreman.blocked && !sendDisabled && ui.decision.status !== 'pending' && foreman.restored
    const documents = useDesktopDocumentAttachments({ ...foremanDocumentScope(chat, sessionId ?? ''), load: attachmentComposer, enabled: editAttachments })
    const alternates = useDesktopForemanAlternates({
        chat, snapshot: retrySnapshot, active: !!retrySnapshot && ui.open && !hidden && !onRoutines && !intake && foreman.restored,
        eligible: !!retrySnapshot && !streaming && !pendingRequest && !pendingStarter && !foreman.blocked && ui.decision.status !== 'pending',
    })
    const { close: closeAlternates, open: alternatesOpen } = alternates
    const mentions = useDesktopMentionAutocomplete({
        targets: editAttachments && !alternatesOpen && mentionTargets ? mentionTargets : NO_MENTION_TARGETS,
        skills: NO_SKILLS, requireCallable: false, text: ui.draft, mentions: ui.draftCoworkerMentions ?? NO_MENTIONS,
        scope: `${chat.workspaceId}:${chat.chatId}`,
        onDraftChange: foreman.setDraft,
    })
    const runByCall = useMemo(() => new Map(callSources?.map(source => [source.callId, source.runId])), [callSources])
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
    // A task is saved by its first message: the conversation just created sends it through the same path as the composer.
    const sendRef = useRef(send)
    sendRef.current = send
    const firstSent = useRef<string | undefined>(undefined)
    const firstDrafted = useRef<string | undefined>(undefined)
    useEffect(() => {
        if (!firstSend || !foreman.restored) return
        // The text is put in the composer as soon as it arrives, so it is saved as the draft even if
        // the send has to wait (for the task's model to be saved) and the person leaves meanwhile.
        if (firstDrafted.current !== firstSend.id) {
            firstDrafted.current = firstSend.id
            foreman.setDraft(firstSend.text, firstSend.coworkerMentions ?? [])
        }
        if (!firstSend.send || firstSent.current === firstSend.id) return
        firstSent.current = firstSend.id
        sendRef.current(firstSend.text)
    }, [firstSend, foreman.restored, foreman.setDraft])
    async function retrySend() {
        if (!pendingSend || !onRetryPendingSend || retryDisabled || retryInFlight.current) return
        const scope = composerScope.current
        retryInFlight.current = true
        setRetryingSend(true)
        setRetrySendError(null)
        try {
            if (!await onRetryPendingSend(pendingSend.requestId)) throw new Error(t('foreman.pendingSend.failed'))
            const current = composerScope.current
            if (current.chatId !== scope.chatId || current.workspaceId !== scope.workspaceId) return
            foreman.clearSendError()
            const original = trimDesktopCoworkerMentions(scope.draft, scope.mentions)
            if (current.draft === scope.draft && current.mentions === scope.mentions
                && scope.draft.trim() === pendingSend.text
                && JSON.stringify(original.coworkerMentions ?? []) === JSON.stringify(pendingSend.coworkerMentions ?? [])) {
                foreman.setDraft('')
            }
            if (pendingSend.documents) await documents.refresh().catch(() => {})
        } catch (error) {
            setRetrySendError({ requestId: pendingSend.requestId, text: error instanceof Error ? error.message : t('foreman.pendingSend.failed') })
        } finally {
            retryInFlight.current = false
            setRetryingSend(false)
        }
    }
    const triggerRef = useRef<HTMLElement | null>(null)
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
    const starterPack = Boolean(!separateConversation && !intakeFinished && !starter && onReviewTemplate && foreman.restored && messages.length === 0 && !plan.view && !foreman.build)
    const welcomeActionsDisabled = !!(hidden || !ui.open || onRoutines || alternates.open || retryDisabled || pendingSend || ui.draft
        || documents.attachments.length || sendingDocuments || attachmentComposer && (!documents.loaded || documents.busy))
    return (
        <DesktopForemanOrbStage mood={orbMood}>
        <DesktopForemanDockLayout scope={dockBinding.scope} open={ui.open} hidden={hidden} fill={fill}
            placement={dockBinding.placement} dock={dockBinding.dock} onPlacement={dockBinding.onPlacement} onDock={dockBinding.onDock}
            onClose={() => changeOpen(false)} returnFocus={() => triggerRef.current} onLayout={onLayout}>
            {header => <div ref={column} className={cn('relative flex h-full min-h-0 flex-col', detailsOpen && wide && DESKTOP_DETAILS_ROOM)} onKeyDown={event => {
                // Escape in its panel closes it, as it closes a coworker's card. A dialog or a field in it keeps its own Escape.
                const target = event.target as HTMLElement
                if (detailsOpen && event.key === 'Escape' && !event.defaultPrevented && target.closest('[data-foreman-details]') && !target.closest('[role="dialog"], [role="alertdialog"], input, textarea')) {
                    event.preventDefault()
                    event.stopPropagation()
                    setDesktopDetailsWanted(false)
                }
            }}>
                {framed && framedBar ? <DesktopForemanTopBar bar={framedBar}
                    name={<FloatingPill label={t('workspaceView.foreman.card')} active={detailsOpen} onClick={() => setDesktopDetailsWanted(!detailsOpen)} className="max-w-full pl-1.5">
                        <DesktopForemanNameMark orbState={orbState} />
                        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </FloatingPill>} />
                : <DesktopForemanHeader
                    onDragPointerDown={header.onPointerDown}
                    anchor={desktopForemanAnchorOf(dockBinding.placement)}
                    crumb={intake ? undefined : headerCrumb}
                    orbState={orbState}
                    open={ui.open}
                    tab={ui.tab}
                    onTabChange={foreman.setTab}
                    onClose={() => changeOpen(false)}
                    actions={<>
                        {/* Its place is fixed in the middle of the Simple view: nothing to move there. */}
                        {!fill && <DesktopForemanMove placement={dockBinding.placement} onPlacement={dockBinding.onPlacement} disabled={hidden} />}
                        {headerActions}
                        {retrySnapshot && !onRoutines && !intake && alternates.items.length > 0 && !alternates.open &&
                            <Button type="button" size="icon-xs" variant="ghost" aria-label={t('foreman.alternates.title')}
                                title={t('foreman.alternates.title')} onClick={alternates.openList}><RotateCwIcon /></Button>}
                    </>}
                />}
                <div className={onRoutines || alternates.open ? 'hidden' : 'contents'}>
                    {intake ? <>
                        <div className="relative flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-3 py-6">
                            {/* Where no board is behind the questions, what the website read found is shown above them. */}
                            {/* The GitHub projects are reviewed here in every layout: their cards are edited, which the board preview is not. */}
                            <div className="absolute inset-x-0 top-0 z-30 max-h-[45%] space-y-2 overflow-y-auto px-3 pt-3">
                                {!renderBoardOverlay && <DesktopIntakeSiteProfile chat={chat} intake={intake} active={ui.open && !hidden} />}
                                <DesktopIntakeGithubProjects github={github} intake={intake} />
                            </div>
                            <DesktopForemanIntakeHeader intake={intake} />
                        </div>
                        <div className="shrink-0 px-3 pb-3"><DesktopForemanIntakeCard intake={intake} github={github} autoFocus={ui.open && !hidden} /></div>
                    </> : <>
                    <DesktopForemanChatLayer
                        messages={messages}
                        active={ui.open && !hidden && !onRoutines && !alternates.open}
                        findScope={findEnabled && ui.open && foreman.restored && !onRoutines && !alternates.open
                            ? JSON.stringify([chat.workspaceId, chat.chatId]) : undefined}
                        findHidden={hidden}
                        onCloseFind={() => column.current?.querySelector<HTMLTextAreaElement>('textarea[data-desktop-foreman-composer]:not([disabled])')?.focus({ preventScroll: true })}
                        streaming={streaming}
                        liveReply={liveReply}
                        restored={foreman.restored}
                        question={foreman.restored && !streaming && pendingRequest ? <>
                            {question && onAnswerQuestion && <DesktopArrive key={question.id} id={`foreman-question:${chat.chatId}:${question.id}`} live={arrivesLive()}>
                                <DesktopQuestionCard question={question} disabled={hidden || !!foreman.blocked}
                                    voiceTarget={ui.open && !onRoutines && !alternates.open ? { chat } : undefined}
                                    documentScope={sessionId ? foremanDocumentScope(chat, sessionId, question.id) : undefined}
                                    onAnswer={onAnswerQuestion} />
                            </DesktopArrive>}
                            {approval && onDecideApproval && <DesktopArrive key={approval.id} id={`foreman-approval:${chat.chatId}:${approval.id}`} live={arrivesLive()}>
                                <DesktopApprovalCard approval={approval} disabled={hidden || !!foreman.blocked} onDecide={onDecideApproval} />
                            </DesktopArrive>}
                        </> : null}
                        underCrumb={!!headerCrumb}
                        framed={framed}
                        emptyWelcome={!starterPack && !pendingStarter}
                        emptyContent={team && !starterPack && !pendingStarter && !starter && <DesktopForemanTeamWelcome
                            agents={team} firstName={firstName} nextRoutine={nextRoutine} now={routineNow}
                            disabled={welcomeActionsDisabled}
                            onAction={(text, selected, submit) => {
                                if (welcomeActionsDisabled || isDesktopQuitting() || composerScope.current.draft) return
                                foreman.setDraft(text, selected)
                                if (submit) send(text.trim())
                                else requestAnimationFrame(() => column.current?.querySelector<HTMLTextAreaElement>('textarea[data-desktop-foreman-composer]:not([disabled])')?.focus())
                            }}
                        />}
                        planSnapshot={foreman.planSnapshot}
                        decisionStatus={ui.decision}
                        build={foreman.build}
                        nextSteps={foreman.nextSteps}
                        leadState={foreman.leadState}
                        writing={orbState === 'speaking'}
                        error={(starterError?.offerId === starter?.offerId ? starterError?.message : null) || alternates.error || foreman.error || (foreman.blocked ? `Blocked: ${foreman.blocked.replaceAll('_', ' ')}` : null)}
                        runNotice={runNotice}
                        onConfirmPlan={foreman.confirmPlan}
                        onAskChanges={() => foreman.askChanges()}
                        onRetryDecision={foreman.retryDecision}
                        onResumeBuild={() => void foreman.actOnBuild('resume')}
                        onStopBuild={() => void foreman.actOnBuild('stop')}
                        buildBusy={foreman.buildBusy}
                        onStartLead={foreman.startLead}
                        onOpenSetup={onOpenCalledChat}
                        onOpenCreated={step => foreman.navigate({ kind: 'open_coworker', agentId: step.agentId, sessionId: step.sessionId })}
                        onOpenCoworker={input => foreman.navigate({ kind: 'open_coworker', agentId: input.agentId, sessionId: input.sessionId })}
                        onOpenBox={spaceId => foreman.navigate({ kind: 'open_box', spaceId })}
                        answerFeedback={{ ratingOf: answerFeedback.ratingOf, onRate: answerFeedback.rate, disabled: hidden }}
                        readAloud={speech?.configured && !hidden ? chat : undefined}
                        threads={intake ? undefined : threads} onOpenThread={onOpenThread}
                        replyRetry={retrySnapshot ? { review: id => void alternates.reviewReply(id),
                            disabled: !!streaming || pendingRequest || pendingStarter || !!foreman.blocked || alternates.busy || ui.decision.status === 'pending' } : undefined}
                        renderChildWork={sessionId && ui.open && !hidden && !onRoutines && !alternates.open && foreman.restored
                            ? slots => <Fragment key={`${chat.workspaceId}:${chat.chatId}`}>
                                <DesktopDelegationMount scope="foreman" sessionId={chat.chatId}
                                    agentId={FOREMAN_AGENT_ID} followLive={!!live} stopRunId={live?.runId ?? null}
                                    placeCard={(snapshot, card) => {
                                        const slot = slots.get(snapshot.parentRunId)
                                        const settled = snapshot.tasks.every(task => task.cleanup === 'complete' && task.status !== 'running' && task.status !== 'queued')
                                        return slot && settled ? createPortal(card, slot, snapshot.delegationId) : card
                                    }} />
                                <DesktopCoworkerCalls agentId={FOREMAN_AGENT_ID} sessionId={chat.chatId} fallback={null}
                                    currentRunActive={!!live} onOpenTarget={onOpenCalledChat}
                                    placeCard={(call, card) => {
                                        const runId = runByCall.get(call.callId)
                                        const slot = runId && slots.get(runId)
                                        return slot && ['completed', 'error', 'cancelled', 'interrupted'].includes(call.status)
                                            ? createPortal(card, slot, call.callId) : card
                                    }} />
                            </Fragment>
                            : undefined}
                        className="min-h-0 flex-1"
                    >
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
                    {pendingSend && onRetryPendingSend && <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                        <p className="min-w-0 flex-1" role="status">{t('foreman.pendingSend.unconfirmed')}</p>
                        <Button type="button" size="sm" variant="outline" disabled={retryDisabled || retryingSend}
                            loading={retryingSend} onClick={() => void retrySend()}>{t('foreman.pendingSend.retry')}</Button>
                        {retrySendError?.requestId === pendingSend.requestId && <p className="basis-full text-destructive" role="alert">{retrySendError.text}</p>}
                    </div>}
                    {!intake && !pendingStarter && sessionId && messages.length > 0 && <DesktopForemanTeamChanges chat={chat} refreshKey={`${messages.length}:${String(!!streaming)}`} />}
                    {!intake && !pendingStarter && <DesktopForemanGithubProjects github={github} chat={chat} onSend={send} sendDisabled={!!streaming || !!pendingSend || retryingSend || pendingRequest}
                        refreshKey={`${messages.length}:${String(!!streaming)}:${foreman.build?.buildId ?? ''}:${foreman.build?.status ?? ''}`} />}
                    {/* Said while the links are still in the box, so it is clear they will be read. */}
                    {!intake && !pendingStarter && draftRepositories > 0 && <p data-foreman-github-hint role="status" className="mx-3 mt-2 text-[11px] text-muted-foreground">
                        {draftRepositories === 1 ? '1 GitHub repository' : `${draftRepositories} GitHub repositories`} will be read when you send. Nothing is cloned or run.
                    </p>}
                    {/* In a coworker's frame the composer sits under its line, in the conversation's column. */}
                    <div className={framed ? 'shrink-0 border-t border-border' : 'contents'}>
                    <DesktopForemanComposer
                        mentions={mentions}
                        trailing={intake || pendingStarter ? undefined : composerTrailing}
                        controls={intake || pendingStarter || !ui.open ? undefined : <>
                            {attachmentComposer && <DesktopDocumentPicker disabled={!editAttachments || !documents.loaded} onFiles={documents.add} />}
                            {voiceSlot}
                        </>}
                        micReplacesSend={!!voiceMic && !!voiceSlot && !intake && !pendingStarter && ui.open}
                        attachments={attachmentComposer && (documents.attachments.length > 0 || documents.error)
                            ? <DesktopDocumentAttachmentControls controller={documents} disabled={!editAttachments} /> : undefined}
                        hasAttachments={attachmentComposer && documents.attachments.length > 0}
                        onFiles={editAttachments && documents.loaded ? documents.add : undefined}
                        className={framed ? 'mx-auto w-full max-w-[48rem]' : undefined}
                        placeholder={intake || pendingStarter ? t('foreman.ownEntryPlaceholder') : !framed || !framedBar ? undefined
                            : framedBar.thread?.named ? t('reply', { title: framedBar.thread.title }) : t('message', { name: t('workspaceView.foreman.name') })}
                        maxLength={intake || pendingStarter ? 4000 : undefined}
                        draft={ui.draft}
                        onDraftChange={foreman.setDraft}
                        busy={!!streaming}
                        sendDisabled={sendDisabled || !!pendingSend || retryingSend || attachmentComposer && (sendingDocuments || !documents.loaded || documents.busy > 0)}
                        disabled={pendingRequest || !foreman.restored || !!foreman.blocked || ui.decision.status === 'pending'
                            || pendingStarter && (!onStarterAnswer || starterBusy || !!starter?.decision)
                            || Boolean(intake && (!intake.restored || intake.submitting || intake.quitting || intake.conflicted))}
                        onSend={send}
                        onStop={() => void foreman.stop()}
                    />
                    </div>
                </div>
                {!onRoutines && alternates.open && <DesktopForemanAlternates ui={alternates}
                    sourceText={id => messages.find(message => message.id === id)?.text} />}
                <DesktopForemanAlternateReview ui={alternates} />
                {/* Its panel beside the chat, the column a coworker's card has: who it is, then every routine of
                    the workspace (upstream #317). Over the chat on a narrower window, behind the same backdrop. */}
                {framed && detailsOpen && !wide && <button type="button" aria-label="Back to the chat" className="absolute inset-0 z-30 bg-foreground/5 backdrop-blur-[2px]" onClick={() => setDesktopDetailsWanted(false)} />}
                {framed && <DesktopDetailsColumn label={t('workspaceView.foreman.card')} open={detailsOpen} beside={wide}>
                    {detailsMounted && <DesktopForemanDetails orbState={orbState} shown={detailsOpen} onClose={() => setDesktopDetailsWanted(false)} routines={
                        <DesktopWorkspaceRoutines
                            key={`details:${chat.workspaceId}`}
                            client={routinesClient}
                            // Out of sight it reads nothing, and reads once when it shows again (upstream #319).
                            active={detailsOpen && ui.open && !hidden}
                            onOpenChat={target => foreman.navigate({ kind: 'open_coworker', agentId: target.agentId, sessionId: target.sessionId })}
                            docked={false}
                            agentNameOf={agentNameOf}
                            className="min-h-0 flex-1"
                        />} />}
                </DesktopDetailsColumn>}
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
        </DesktopForemanOrbStage>
    )
}
