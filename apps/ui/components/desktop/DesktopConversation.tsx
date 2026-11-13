'use client'

import { useDesktopLocale } from './DesktopLocale'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { CompactionStep } from '@/components/chat/CompactionBlock'
import { savedCompactionOf } from '@/lib/desktop/compaction'
import { ChatTimeSeparator } from '@/components/chat/ChatTimeSeparator'
import { MessageTimeTooltip } from '@/components/chat/MessageTimeTooltip'
import { ExpandableMessageBody } from '@/components/chat/ExpandableMessageBody'
import { ComposerLinkMirror } from '@/components/chat/ComposerLinkMirror'
import { timeBreaksOf } from '@/lib/chat/message-times'
import { DesktopConversationOverview, type DesktopConversationOverviewAuthority } from './coworker-overview/conversation-mount'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { useChat } from '@ai-sdk/react'
import { useRunReconnect } from '@/hooks/useRunReconnect'
import { isLongMessage } from '@/lib/composer'
import { replayedRunFailure } from '@/lib/desktop/chat-resume'
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type FileUIPart } from 'ai'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { Message, MessageContent, Suggestion, Suggestions } from '@rerun/ui/chat'
import { FloatingPill } from '@/components/agent/sheet/floating'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton, type ConversationHandle } from '@/components/ai-elements/conversation'
import { bringBlockIn, useArriveByTop } from '@/hooks/useArriveByTop'
import type { DesktopChatRequest } from '@/lib/desktop/chat-request'
import { summarizePendingHitl } from '@/lib/chat/hitl-cue'
import type { HitlKind } from '@rerun/contracts'
import { DesktopThreadBranch } from './DesktopThreadBranch'
import { generalTabUid } from '@/lib/desktop/general-threads'
import { threadsByMessage } from '@/lib/chat/thread-rows'
import { USER_BUBBLE_INK, USER_BUBBLE_SHAPE } from '@/components/chat/bubble-styles'
import { ArrowUpIcon, ChevronDownIcon, Maximize2Icon, PlusIcon, SendIcon, SquareIcon, UploadIcon, UserRoundIcon, XIcon } from '@/lib/icons'
import { MarkdownEditorDialog } from '@/components/ui/markdown-editor-dialog'
import { DesktopConversationFind } from './DesktopConversationFind'
import { DesktopProviderErrorNotice } from './chat/recovery/DesktopProviderErrorNotice'
import { formatFxAttachmentRejections, formatFxDocumentRejections, planFxAttachmentBatch } from '@/lib/desktop/fx-repairs/attachment-overflow'
import { useDesktopChatRecovery } from '@/lib/desktop/chat-recovery/use-desktop-chat-recovery'
import { MessageFeedbackDialog } from '@/components/chat/MessageFeedbackDialog'
import { useDesktopReplyFeedback } from '@/lib/desktop/reply-feedback'
import { DesktopComputerPanel } from './computer-panel/DesktopComputerPanel'
import { DesktopSelectedMentionText } from './mentions/DesktopSelectedMentionText'
import { DesktopWorkspaceMessage } from './DesktopWorkspaceMessage'
import { DesktopAssistantReply } from './DesktopAssistantReply'
import { DesktopSavedDecisionReceipt } from './DesktopSavedDecisionReceipt'
import { desktopSavedChatReceiptOf } from '@/lib/desktop/saved-chat-decision'
import { DesktopChatActivity } from './DesktopChatActivity'
import { DesktopVoiceComposer } from './voice/DesktopVoiceComposer'
import { DesktopVoiceHistoryMessage } from './voice/DesktopVoiceHistoryMessage'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { lastUserText } from '@/lib/chat-payload'
import { cn } from '@/lib/utils'
import type { DesktopAgentView, DesktopSessionView } from './DesktopApp'
import { DesktopCoworkerSettings } from './DesktopCoworkerSettings'
import { DesktopCoworkerMemories } from './DesktopCoworkerMemories'
import { desktopServiceRequestViewSchema, parseHitlReply, parseInstallMessage, parseVoiceMessage, type DesktopVoiceSendReceipt, type BoxDefaultModel, type ConnectionSummary } from '@rerun/contracts'
import { DesktopServiceRequestBlock, type DesktopServiceRequestBlockProps } from './service-requests/DesktopServiceRequestBlock'
import { DesktopServiceRequestReceipt } from './service-requests/DesktopServiceRequestReceipt'
import { DesktopMcpSignInBlock } from './mcp-sign-in/DesktopMcpSignInBlock'
import { DesktopMcpSignInSummary } from './mcp-sign-in/DesktopMcpSignInReceipt'
import { readDesktopMcpSignIn } from '@/lib/desktop/mcp-sign-in-client'
import type { DesktopMcpSignInResponse } from '@rerun/contracts'
import { DesktopSecretRequestBlock } from './secret-requests/DesktopSecretRequestBlock'
import { DesktopSecretSummaryReceipt } from './secret-requests/DesktopSecretRequestReceipt'
import { readDesktopSecretRequest } from '@/lib/desktop/secret-requests-client'
import { parseDesktopSecretReceiptSummary, type DesktopSecretRequestView } from '@rerun/contracts'
import type { DesktopOpenApps } from '@/lib/desktop/service-requests-client'
import { useDesktopSetup } from './setup/useDesktopSetup'
import { DesktopInstallBlock as AgentInstallBlock } from './setup/DesktopInstallBlock'
import { DesktopSetupGate, DesktopSetupSkippedBanner } from './setup/DesktopSetupGate'
import { DesktopCoworkerSetup } from './DesktopCoworkerSetup'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'
import { DesktopCoworkerData } from './DesktopCoworkerData'
import { DesktopBoundTriggersPanel } from './triggers/DesktopBoundTriggersPanel'
import { DesktopWebhookRunBlock } from './triggers/DesktopWebhookRunBlock'
import { parseTriggerPayload } from '@rerun/contracts'
import { DesktopCoworkerRoutines } from './DesktopCoworkerRoutines'
import { DesktopCoworkerSkills } from './DesktopCoworkerSkills'
import { DesktopCoworkerMentions } from './mentions/DesktopCoworkerMentions'
import { reconcileDesktopCoworkerMentions } from '@/lib/desktop/coworker-mentions'
import { desktopCoworkerMentionFieldsOf, trimDesktopCoworkerMentions, type DesktopCoworkerMention, type DesktopCoworkerMentionFields } from '@rerun/contracts'
import { DesktopCoworkerNotificationControl } from './DesktopCoworkerNotificationBell'
import { DesktopSkillProposalDock } from './skills/DesktopSkillProposalDock'
import { useCoworkerSkillProposals } from '@/lib/desktop/use-coworker-skill-proposals'
import { desktopSkillProposalIds } from '@/lib/desktop/skill-proposal-source'
import { DesktopScheduledRunBlock } from './DesktopScheduledRunBlock'
import { DesktopCoworkerTools } from './DesktopCoworkerTools'
import { DesktopNativeWritebackReview } from './DesktopNativeWritebackReview'
import { DesktopCoworkerMcpDialog } from './DesktopCoworkerMcpDialog'
import { DesktopVaultDialog } from './vault/DesktopVaultDialog'
import { DesktopServicesDialog } from './services/DesktopServicesDialog'
import { DesktopCoworkerMonitoring } from './DesktopCoworkerMonitoring'
import { useDesktopPanelCloseGuard, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopCoworkerPanel } from '@/lib/desktop/coworker-panel'
import type { DesktopCoworkerPanelRequest } from '@/lib/desktop/coworker-panel-request'
import { AttachmentChips, DesktopAttachmentPicker } from './DesktopAttachmentPicker'
import { DesktopWorkspaceAttachmentLightbox, type WorkspaceAttachmentSource } from './DesktopWorkspaceAttachmentLightbox'
import { useDesktopDocumentAttachments } from '@/lib/desktop/document-attachments/useDesktopDocumentAttachments'
import { DesktopDocumentAttachmentControls } from './document-attachments/DesktopDocumentAttachmentControls'
import { DesktopDocumentLightbox } from './document-attachments/DesktopDocumentLightbox'
import { desktopDocumentReferenceSchema, type DesktopDocumentReference, type DesktopDocumentSendSelection } from '@rerun/contracts'
import { DesktopUploadChips } from './DesktopUploadChips'
import { DesktopImageUploadChips } from './DesktopImageUploadChips'
import { ChatAttachmentChip } from '@/components/chat/ChatAttachmentChip'
import { MessageAttachments } from '@/components/chat/MessageAttachments'
import { DESKTOP_IMAGE_UPLOAD_ACCEPT } from '@/lib/desktop/composer-image'
import { useDesktopComposerImageUploads } from '@/lib/desktop/use-composer-image-uploads'
import { DESKTOP_UPLOAD_ACCEPT } from '@/lib/desktop/composer-upload'
import { useDesktopComposerUploads } from '@/lib/desktop/use-composer-uploads'
import { pendingTabWrite } from '@/lib/desktop/tab-writes'
import { DesktopModelSelector, type DesktopModelBlock } from './DesktopModelSelector'
import type { DesktopModelPick } from '@/lib/desktop/chat-model'
import { QueuedMessagePill } from '@/components/chat/QueuedMessagePill'
import { shouldFlush, shouldKeepQueued } from '@/lib/chat/queued-message'
import { desktopQueuedAttachmentSelections as desktopQueuedAttachmentPaths, desktopQueuedPreview, type DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { useDesktopQueuedMessage } from '@/lib/desktop/use-queued-message'
import { HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions, desktopAttachmentFieldsOf, desktopAttachmentSelectionsOf as desktopAttachmentPathsOf, parseScheduledRun, type DesktopAttachmentFields, type DesktopAttachmentSelection, type DesktopImageSnapshot } from '@rerun/contracts'
import { desktopQuestionViewSchema, type DesktopPendingQuestion, type DesktopQuestionAnswer } from '@/lib/desktop/questions'
import { DesktopToolInstallPending } from './tool-install/DesktopToolInstallPending'
import { DesktopQuestionCard } from './DesktopQuestionCard'
import { questionDocumentTabUid } from '@/lib/desktop/question-documents'
import { desktopApprovalViewSchema, type DesktopPendingApproval, type DesktopApprovalAnswer } from '@/lib/desktop/approvals'
import { DesktopApprovalCard } from './DesktopApprovalCard'
import { desktopQuickRepliesOf } from '@/lib/desktop/quick-replies'
import { useDesktopComposerDraft } from '@/lib/desktop/use-composer-draft'
import { desktopDraftRecord, holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'

import { desktopTakeoverViewSchema, type DesktopPendingTakeover, type DesktopTakeoverTerminal } from '@/lib/desktop/takeover'
import { takeoverScreenApi } from '@/lib/desktop/takeover-screen'
import { IsolatedScreenDialog } from './isolated-screen/IsolatedScreenDialog'
import { useDesktopWebhookRequest } from './useDesktopWebhookRequest'
import { DesktopWebhookHumanRequest } from './trigger-requests/DesktopWebhookHumanRequest'
import type { TriggerRequestForm, TriggerRequestView } from '@/lib/desktop/trigger-requests/types'
import { DesktopBrowserCard } from './isolated-screen/DesktopBrowserCard'

type ServiceRequest = DesktopServiceRequestBlockProps['request']
type AcceptedService = Parameters<DesktopServiceRequestBlockProps['onAccepted']>[0] & { secretRequestId?: string; mcpSignInRequestId?: string; triggerRequestKind?: TriggerRequestView['link']['kind'] }
class AcceptedResponseDecoder extends DefaultChatTransport<UIMessage> {
    decode(response: Response) { if (!response.body) throw new Error('The app response has no stream.'); return this.processResponseStream(response.body) }
}
async function serviceRequestFor(sessionId: string, signal: AbortSignal) {
    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/service-requests`, { signal, cache: 'no-store' })
    if (!response.ok) throw new Error('Could not load the coworker’s app request. Try again.')
    const value = desktopServiceRequestViewSchema.parse(await response.json()).request
    return value?.receipt?.accepted ? null : value
}
async function secretRequestFor(sessionId: string, signal: AbortSignal) {
    const request = await readDesktopSecretRequest(sessionId, { signal })
    return request?.status === 'accepted' ? null : request
}

const takeoverUrl = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/takeover`
async function takeoverFor(sessionId: string, signal: AbortSignal) {
    const response = await fetch(takeoverUrl(sessionId), { signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error ?? 'Could not load the browser request.')
    return desktopTakeoverViewSchema.parse(body).takeover
}

const approvalUrl = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/approvals`
async function approvalFor(sessionId: string, signal: AbortSignal) {
    const response = await fetch(approvalUrl(sessionId), { signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load the coworker’s approval request. Try again.')
    return desktopApprovalViewSchema.parse(body).approval
}

const questionUrl = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/questions`
async function questionFor(sessionId: string, signal: AbortSignal) {
    const response = await fetch(questionUrl(sessionId), { signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load the coworker’s question. Try again.')
    return desktopQuestionViewSchema.parse(body).question
}

type DesktopHistoryRead = { messages: UIMessage[]; lastError: string | null; activeRunId: string | null; runsUnavailable: boolean; runVersion?: string | null }

async function historyFor(sessionId: string, signal: AbortSignal): Promise<DesktopHistoryRead> {
    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/messages`, { signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load conversation history')
    if (!Array.isArray(body.messages)) throw new Error('Could not load conversation history')
    return {
        messages: body.messages as UIMessage[],
        lastError: typeof body.lastError === 'string' ? body.lastError : null,
        activeRunId: typeof body.activeRunId === 'string' ? body.activeRunId : null,
        runsUnavailable: body.runsUnavailable === true,
        runVersion: typeof body.runVersion === 'string' ? body.runVersion : body.runVersion === null ? null : undefined,
    }
}

const stopUrl = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/stop`
const RUN_POLL_MS = 3000

export type ComposerDraft = DesktopCoworkerMentionFields & { text: string; attachment?: string; attachments?: DesktopAttachmentSelection[] }
export type TabActivity = { busy: boolean; dirty: boolean; recordingPending?: boolean; readableSessionId?: string | null }

const draftPaths = (draft: ComposerDraft | undefined) => draft ? (draft.attachments?.length ? draft.attachments : draft.attachment ? [draft.attachment] : []) : []
const samePaths = (a: readonly DesktopAttachmentSelection[], b: readonly DesktopAttachmentSelection[]) => JSON.stringify(a) === JSON.stringify(b)
const messageAttachmentPaths = (metadata: unknown): DesktopAttachmentSelection[] =>
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? desktopAttachmentPathsOf(metadata as DesktopAttachmentFields) : []

function scheduledRunOf(message: UIMessage) {
    if (message.role !== 'user') return null
    const prompt = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    const value = message.metadata && typeof message.metadata === 'object' && 'scheduledRun' in message.metadata ? message.metadata.scheduledRun : null
    if (value && typeof value === 'object' && 'slug' in value && 'name' in value && typeof value.slug === 'string' && typeof value.name === 'string') return { slug: value.slug, name: value.name, prompt }
    // The desktop saved-history pipeline preserves the original marker; the hosted API can
    // instead lift it into metadata. Rerun's exact whole-message parser supports both paths.
    return parseScheduledRun(prompt)
}

export function DesktopConversation({ agent, workspaceId, sessionId, sessions, pendingChatSummaries, tabUid, active = true, arrival, requestedPanel, onPanelRequestHandled, tabStrip, initialDraft, onTabActivity, onStartFork, onFinishFork, onSelectSession, onChatSession, renderHistory, onHistoryVisibility, renderRunHistory, onOpenCoworkerChat, onClosePanel, modelLabel, workspaceDefault, connections, onOpenModelSettings, onOpenTranscriptionSettings, overview }: {
    agent: DesktopAgentView
    workspaceId?: number | null
    sessionId: string | null
    sessions: DesktopSessionView[]
    pendingChatSummaries?: ReadonlyMap<string, string>
    onSelectSession: (id: string | null, title?: string) => void
    onStartFork?: (uid: string) => boolean
    onFinishFork?: (uid: string) => void
    tabUid?: string
    active?: boolean
    arrival?: DesktopChatRequest | null
    requestedPanel?: DesktopCoworkerPanelRequest | null
    onPanelRequestHandled?: (request: DesktopCoworkerPanelRequest) => void
    tabStrip?: ReactNode
    initialDraft?: ComposerDraft
    onTabActivity?: (uid: string, state: TabActivity) => void
    onChatSession: (id: string, sourceDraft?: ComposerDraft) => void | boolean | Promise<boolean>
    renderHistory?: (busy: boolean, control: { needsRequest: number | null; active: boolean; onOpenChange: (open: boolean) => void }) => ReactNode
    onHistoryVisibility?: (tabUid: string, visible: boolean) => void
    renderRunHistory?: (control: DesktopDialogControl) => ReactNode
    onOpenCoworkerChat?: (target: { agentId: string; sessionId: string }) => Promise<void>
    onClosePanel?: () => void
    modelLabel?: string
    workspaceDefault?: BoxDefaultModel | null
    connections?: ConnectionSummary[]
    onOpenModelSettings?: () => void
    onOpenTranscriptionSettings?: () => void
    overview?: DesktopConversationOverviewAuthority
}) {
    const { language, t } = useDesktopLocale()
    const queueCopy = language.messages.queue
    const editorCopy = language.messages.composerEditor
    const locale = desktopLocaleTag(language.locale)
    const setup = useDesktopSetup(agent.id)
    const setupBlocked = !setup.view || !!setup.error || setup.view.pending && (!setup.view.sessionId || setup.view.sessionId !== sessionId)
    const [cardOpen, setCardOpen] = useState(false)
    const [overviewCovered, setOverviewCovered] = useState(false)
    const [serviceStreaming, setServiceStreaming] = useState(false)
    const [voiceActivity, setVoiceActivity] = useState({ busy: false, dirty: false })
    const [voiceReviewTarget, setVoiceReviewTarget] = useState<HTMLDivElement | null>(null)
    const serviceStream = useRef<AcceptedService | null>(null)
    const serviceOwner = useRef({agentId:agent.id,sessionId,active})
    serviceOwner.current = {agentId:agent.id,sessionId,active}
    type AppsFlow = {token:string; slug:string; destination?: 'vault'; settle:(error?:Error, account?: { key: string; revision: string })=>void}
    const appsFlow = useRef<AppsFlow|null>(null)
    const [serviceApps, setServiceApps] = useState<AppsFlow|null>(null)
    const openServiceApps: DesktopOpenApps = input => new Promise((resolve,reject) => {
        if (input.signal.aborted || input.agentId !== agent.id || !active || appsFlow.current || isDesktopQuitting()) { reject(new Error('This app request is no longer active.')); return }
        const token = crypto.randomUUID()
        const abort = () => flow.settle(new Error('App connection cancelled.'))
        const flow: AppsFlow = {token,slug:input.slug,destination:input.destination,settle:(error, account)=>{
            input.signal.removeEventListener('abort',abort)
            if(appsFlow.current?.token!==token)return
            appsFlow.current=null
            setServiceApps(current=>current?.token===token?null:current)
            if(error)reject(error);else resolve({status:'closed', account})
        }}
        appsFlow.current=flow;setServiceApps(flow)
        input.signal.addEventListener('abort',abort,{once:true})
        if(input.signal.aborted)abort()
    })
    useEffect(()=>()=>{appsFlow.current?.settle(new Error('This conversation was closed.'));serviceStream.current?.cancelStream()},[agent.id,sessionId,active])
    const [needsRequest, setNeedsRequest] = useState<number | null>(null)
    const [chatsOpen, setChatsOpen] = useState(false)
    const onChatsOpenChange = useCallback((visible: boolean) => {
        setChatsOpen(visible)
        if (tabUid) onHistoryVisibility?.(tabUid, visible)
    }, [tabUid, onHistoryVisibility])
    const [detailPanel, setDetailPanel] = useState<Exclude<DesktopCoworkerPanel, 'chat'> | null>(null)
    const [focusedSkill, setFocusedSkill] = useState<string | null>(null)
    const [focusedFile, setFocusedFile] = useState<string | null>(null)
    const fileLinkOpener = useRef<HTMLElement | null>(null)
    const fileLinkRequest = useRef<AbortController | null>(null)
    const [panelNotice, setPanelNotice] = useState('')
    const handledPanel = useRef<DesktopCoworkerPanelRequest | null>(null)
    const conversationRoot = useRef<HTMLDivElement>(null)
    const [panelFocus, setPanelFocus] = useState<'chat' | 'card' | null>(null)
    const overviewCloseControl = useDesktopPanelCloseGuard()
    const dismissCard = () => {
        if (requestedPanel) { handledPanel.current = requestedPanel; onPanelRequestHandled?.(requestedPanel) }
        setCardOpen(false)
        setPanelNotice('')
        setPanelFocus('chat')
    }
    const dialogControl = (panel: Exclude<DesktopCoworkerPanel, 'chat'>) => ({
        open: detailPanel === panel,
        onOpenChange: (open: boolean) => {
            // An explicit choice supersedes a pending Settings status read. Its delayed answer
            // must never replace another dialog or bypass that dialog's unsaved-change guard.
            if (open && requestedPanel) { handledPanel.current = requestedPanel; onPanelRequestHandled?.(requestedPanel) }
            setPanelFocus(null)
            setPanelNotice('')
            if (panel === 'skills') setFocusedSkill(null)
            if (panel === 'files') setFocusedFile(null)
            setDetailPanel(open ? panel : null)
        },
    })
    useEffect(() => () => fileLinkRequest.current?.abort(), [active, cardOpen, detailPanel, chatsOpen, agent.id, sessionId])
    const openWorkspaceFile = async (href: string, opener: HTMLElement) => {
        if (!active || cardOpen || detailPanel || chatsOpen || isDesktopQuitting()) return
        fileLinkRequest.current?.abort()
        const request = new AbortController()
        fileLinkRequest.current = request
        try {
            const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agent.id)}/files/link`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ href }), signal: request.signal,
            })
            const result = response.ok ? await response.json() : null
            if (request.signal.aborted || isDesktopQuitting() || !opener.isConnected || opener.closest('[hidden],[inert],[data-desktop-tab-active="false"]')) return
            if (typeof result?.path !== 'string') {
                toast.error(t('linkedFileNotFound'))
                return
            }
            dialogControl('files').onOpenChange(true)
            fileLinkOpener.current = opener
            setFocusedFile(result.path)
        } catch {
            if (!request.signal.aborted && !isDesktopQuitting()) toast.error(t('linkedFileNotFound'))
        } finally {
            if (fileLinkRequest.current === request) fileLinkRequest.current = null
        }
    }
    const restoreWorkspaceFileFocus = (event: Event) => {
        const opener = fileLinkOpener.current
        fileLinkOpener.current = null
        if (!opener) return
        event.preventDefault()
        if (active && !isDesktopQuitting() && opener.isConnected && !opener.closest('[hidden],[inert]')) opener.focus({ preventScroll: true })
    }
    const draftKey = JSON.stringify([agent.id, sessionId])
    const initialPaths = draftPaths(initialDraft)
    const [inputs, setInputs] = useState<ReadonlyMap<string, string>>(() => new Map(initialDraft ? [[draftKey, initialDraft.text]] : []))
    const [attachments, setAttachments] = useState<ReadonlyMap<string, readonly DesktopAttachmentSelection[]>>(() => new Map(initialPaths.length ? [[draftKey, initialPaths]] : []))
    // Ordinary navigation carries the current composer. An alternate and its original keep independent drafts.
    const inputKey = inputs.has(draftKey) ? draftKey : ''
    const composer = useRef<ComposerDraft>({ text: initialDraft?.text ?? '', attachments: initialPaths, coworkerMentions: initialDraft?.coworkerMentions })
    const [mentionValues, setMentionValues] = useState<ReadonlyMap<string, DesktopCoworkerMention[]>>(() => new Map(initialDraft?.coworkerMentions ? [[draftKey, initialDraft.coworkerMentions]] : []))
    const pickedMentions = useRef<DesktopCoworkerMention[] | null>(null)
    const draft = useDesktopComposerDraft(agent.id, tabUid, value => {
        const paths = desktopAttachmentPathsOf(value)
        setInputs(current => new Map(current).set(draftKey, value.text))
        setAttachments(current => {
            const next = new Map(current)
            if (paths.length) next.set(draftKey, paths)
            else next.delete(draftKey)
            return next
        })
        composer.current = { text: value.text, attachments: paths, coworkerMentions: value.coworkerMentions }
        setMentionValues(current => new Map(current).set(draftKey, value.coworkerMentions ?? []))
    })
    // The tab UID remains stable when the first accepted message receives its session ID.
    // Production reads the durable record directly, so newer typing cannot fall off that bind.
    const input = tabUid ? draft.text : inputs.get(inputKey) ?? ''
    const coworkerMentions = tabUid ? draft.coworkerMentions ?? [] : reconcileDesktopCoworkerMentions(input, input, mentionValues.get(inputKey) ?? [])
    const mentionSignature = JSON.stringify(coworkerMentions)
    const attachmentPaths = tabUid ? desktopAttachmentPathsOf(draft) : attachments.get(draftKey) ?? []
    const attachmentSignature = JSON.stringify(attachmentPaths)
    const textAttachments = attachmentPaths.filter((item): item is string => typeof item === 'string')
    const imageAttachments = attachmentPaths.filter((item): item is DesktopImageSnapshot => typeof item !== 'string')
    const setInput = (value: string) => {
        const picked = pickedMentions.current; pickedMentions.current = null
        if (!draft.loaded || draft.error || regenerating.current || isDesktopQuitting()) return
        const nextMentions = picked ?? reconcileDesktopCoworkerMentions(input, value, coworkerMentions)
        setMentionValues(current => new Map(current).set(inputKey, nextMentions))
        setInputs(current => new Map(current).set(inputKey, value))
        composer.current = { text: value, attachments: [...attachmentPaths], coworkerMentions: nextMentions }
        draft.update({ text: value, coworkerMentions: nextMentions, ...desktopAttachmentFieldsOf(attachmentPaths) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the path signature covers inline arrays
    useEffect(() => { composer.current = { text: input, attachments: [...attachmentPaths], coworkerMentions } }, [input, attachmentSignature, mentionSignature])
    const pendingAttachment = useRef<{ key: string; inputKey: string; input: string; attachments: readonly DesktopAttachmentSelection[]; version: number; documents?: DesktopDocumentSendSelection; release: () => void } | null>(null)
    const preparingSubmit = useRef(false)
    const [preparingSend, setPreparingSend] = useState(false)
    const regenerationIds = useRef(new Map<string, string>())
    const regenerating = useRef<{ key: string; agentId: string; sessionId: string; draftKey: string; release: () => void } | null>(null)
    const [regenerationSource, setRegenerationSource] = useState<string | null>(null)
    const setDraftAttachments = useCallback((key: string, paths: readonly DesktopAttachmentSelection[]): boolean => {
        if (!draft.loaded || (draft.error && !draft.attachmentRejected) || regenerating.current || isDesktopQuitting()) return false
        setAttachments(current => {
            const next = new Map(current)
            if (paths.length) next.set(key, [...paths])
            else next.delete(key)
            return next
        })
        if (key === draftKey) {
            composer.current = { ...composer.current, attachments: [...paths] }
            draft.update({ text: composer.current.text, coworkerMentions: composer.current.coworkerMentions, ...desktopAttachmentFieldsOf(paths) })
        }
        return true
    }, [draft.loaded, draft.error, draft.attachmentRejected, draft.update, draftKey])
    const [uploadNotice, setUploadNotice] = useState<string | null>(null)
    const batchNotices = useRef<string[] | null>(null)
    const reportUploadNotice = useCallback((notice: string | null) => {
        if (batchNotices.current) {
            if (notice && !batchNotices.current.includes(notice)) batchNotices.current.push(notice)
            setUploadNotice(batchNotices.current.join(' ') || null)
        } else setUploadNotice(notice)
    }, [])
    const attachUploadedPath = useCallback(async (path: string) => {
        if (!setDraftAttachments(draftKey, [...(composer.current.attachments ?? []).filter(item => item !== path), path])) return false
        return draft.flush()
    }, [draftKey, setDraftAttachments, draft.flush])
    const attachUploadedImage = useCallback(async (image: DesktopImageSnapshot) => {
        const current = composer.current.attachments ?? []
        if (!setDraftAttachments(draftKey, [...current.filter(item => typeof item === 'string' || item.sha256 !== image.sha256), image])) return false
        return draft.flush()
    }, [draftKey, setDraftAttachments, draft.flush])
    const uploadOwner = JSON.stringify([agent.id, tabUid ?? null, sessionId, active])
    const textUploads = useDesktopComposerUploads({
        agentId: agent.id, ownerKey: uploadOwner, tabUid, active: active && !draft.quitting,
        attachedPaths: textAttachments, onConfirmed: attachUploadedPath, onNotice: reportUploadNotice,
    })
    const imageUploads = useDesktopComposerImageUploads({
        agentId: agent.id, ownerKey: uploadOwner, tabUid, active: active && !draft.quitting,
        attachedImages: imageAttachments, onConfirmed: attachUploadedImage, onNotice: reportUploadNotice,
    })
    const documents = useDesktopDocumentAttachments({ agentId: agent.id, tabUid: tabUid ?? sessionId ?? 'legacy-draft', sessionId: sessionId ?? undefined, enabled: active && !draft.quitting && !!tabUid })
    const [documentPreview, setDocumentPreview] = useState<{ attachments: DesktopDocumentReference[]; index: number } | null>(null)
    const [workspacePreview, setWorkspacePreview] = useState<{
        owner: string; source: WorkspaceAttachmentSource; paths: readonly string[]; index: number
    } | null>(null)
    if (workspacePreview && workspacePreview.owner !== uploadOwner) setWorkspacePreview(null)
    useEffect(() => { setDocumentPreview(null) }, [agent.id, tabUid, sessionId, active])
    const { items: uploadItems, remove: removeUpload, retry: retryUpload } = textUploads
    const uploadScope = useRef({ owner: uploadOwner, live: active && !draft.quitting })
    if (uploadScope.current.owner !== uploadOwner) uploadScope.current = { owner: uploadOwner, live: active && !draft.quitting }
    uploadScope.current.live = active && !draft.quitting
    useEffect(() => { const scope = uploadScope.current; scope.live = active && !draft.quitting; return () => { scope.live = false } }, [uploadOwner, active, draft.quitting])
    const batchUpload = useRef<Promise<boolean> | null>(null)
    const [batchActive, setBatchActive] = useState(false)
    const uploadsActive = batchActive || textUploads.active || imageUploads.active || documents.busy > 0
    const uploadsLoaded = textUploads.loaded && imageUploads.loaded && (!tabUid || documents.loaded)
    const uploadsBusy = () => !!batchUpload.current || textUploads.isBusy() || imageUploads.isBusy() || documents.busy > 0
    const uploadsHaveBlocked = () => textUploads.hasBlocked() || imageUploads.hasBlocked()
    const settleUploads = async () => {
        const batchOkay = await batchUpload.current
        const results = await Promise.all([textUploads.settle(), imageUploads.settle()])
        return batchOkay !== false && results.every(Boolean)
    }
    const uploadGate = useRef(false)
    const beginUpload = useCallback((files: File[], refused: string[] = []) => {
        if (uploadGate.current || batchUpload.current || preparingSubmit.current || isDesktopQuitting()) return
        if (!files.length) {
            if (refused.length) setUploadNotice(refused.join(' '))
            return
        }
        const groups = planFxAttachmentBatch(files)
        const scope = uploadScope.current
        const release = holdDraftAdmission()
        setBatchActive(true)
        batchNotices.current = [...refused]
        setUploadNotice(refused.join(' ') || null)
        const failures = [textUploads.failureVersion(), imageUploads.failureVersion()]
        // One ordered drain preserves mixed text/image selection order. Every next file still
        // belongs to the captured tab; closing it or beginning Quit cancels the remaining batch.
        const work = (async () => {
            let rejected = refused.length > 0
            for (const { kind, files: group } of groups) {
                if (uploadScope.current !== scope || !scope.live || isDesktopQuitting()) break
                if (kind === 'image') await imageUploads.start(group)
                else if (kind === 'document') {
                    const added = await Promise.resolve(documents.add(group))
                    const rejections = formatFxDocumentRejections(added)
                    if (rejections.length) {
                        rejected = true
                        reportUploadNotice(rejections.join(' '))
                    }
                }
                else await textUploads.start(group)
            }
            return !rejected && failures[0] === textUploads.failureVersion() && failures[1] === imageUploads.failureVersion()
        })().catch(() => {
            if (uploadScope.current === scope && scope.live) reportUploadNotice('Could not finish adding attachments. Check the attached files before sending.')
            return false
        }).finally(() => {
            batchNotices.current = null
            if (batchUpload.current === work) { batchUpload.current = null; setBatchActive(false) }
            release()
        })
        batchUpload.current = work
    }, [imageUploads.start, textUploads.start, imageUploads.failureVersion, textUploads.failureVersion, documents.add, reportUploadNotice])
    const [history, setHistory] = useState<{ id: string | null | undefined; transcript?: UIMessage[]; question?: DesktopPendingQuestion | null; approval?: DesktopPendingApproval | null; takeover?: DesktopPendingTakeover | null; serviceRequest?: ServiceRequest | null; secretRequest?: DesktopSecretRequestView | null; mcpSignIn?: DesktopMcpSignInResponse | null; error?: string; loadedGeneration?: number; lastError?: string | null; activeRunId?: string | null; runsUnavailable?: boolean; runVersion?: string | null }>({ id: null, question: null, approval: null, takeover: null, serviceRequest: null, secretRequest: null, mcpSignIn: null })
    const responding = useRef<{ sessionId: string; payload: DesktopQuestionAnswer | DesktopApprovalAnswer | DesktopTakeoverTerminal; onAccepted?: () => void; url: string; receiptHeader: string; receiptId: string; accepted: boolean; error?: Error } | null>(null)
    const quickReplyRequest = useRef<{ sessionId: string; requestId: string; accepted: boolean } | null>(null)
    const quickReplyIds = useRef(new Map<string, string>())
    const quickReplyContext = useRef<{ scope: string; messageId?: string; canSend: boolean }>({ scope: draftKey, canSend: false })
    const [quickReplyBusy, setQuickReplyBusy] = useState(false)
    const [quickReplyRetry, setQuickReplyRetry] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    // An engine run still generating for this conversation (e.g. after reopening it mid-reply).
    const [engineRunning, setEngineRunning] = useState<{ id: string | null; running: boolean; runId?: string | null; failedRunId?: string | null; failedRunError?: string | null }>({ id: null, running: false })
    const [modelRevision, setModelRevision] = useState(0)
    const [stopping, setStopping] = useState(false)
    const [stopError, setStopError] = useState<string>()
    const [liveSessionId, setLiveSessionId] = useState<string | null>(null)
    const [liveRunId, setLiveRunId] = useState<string | null>(null)
    const queue = useDesktopQueuedMessage(agent.id, sessionId, tabUid)
    const queueScope = useRef(queue.key)
    useEffect(() => { queueScope.current = queue.key; return () => { queueScope.current = '' } }, [queue.key])
    const [queueNotice, setQueueNotice] = useState<keyof typeof queueCopy>()
    const [modelReady, setModelReady] = useState(false)
    const [modelBlock, setModelBlock] = useState<DesktopModelBlock | null>(null)
    const [openModelRequest, setOpenModelRequest] = useState(0)
    function resolveModelBlock(block: DesktopModelBlock) {
        if (block === 'unavailable' || !onOpenModelSettings) setOpenModelRequest(value => value + 1)
        else onOpenModelSettings()
    }
    const [sendQueuedId, setSendQueuedId] = useState<string | null>(null)
    const flushingQueue = useRef<string | null>(null)
    const restoredQueues = useRef(new Set<string>())
    const draftQueues = useRef(new Set<string>())
    const pendingQueue = useRef<{ item: DesktopQueuedMessage; sessionId: string; acknowledge: () => Promise<unknown> } | null>(null)
    const conversationChoice = useRef<{ session: string | null; pick?: DesktopModelPick } | null>(null)
    const rememberModel = useCallback((pick: DesktopModelPick | undefined) => { conversationChoice.current = { session: sessionId, pick }; setModelRevision(value => value + 1) }, [sessionId])

    const resumeTarget = useRef<{ sessionId: string; runId: string } | null>(null)
    const completedRef = useRef(false)
    const sendToEngine = useCallback<typeof fetch>(async (url, init) => {
        const pending = pendingAttachment.current
        const alternate = regenerating.current
        const queued = pendingQueue.current
        const answer = responding.current
        const quickReply = quickReplyRequest.current
        try {
        let response: Response
        try {
            if (tabUid) await pendingTabWrite(agent.id)
            response = await fetch(answer ? answer.url : url, answer ? { ...init, body: JSON.stringify(answer.payload) } : init)
            if ((pending || alternate || queued || answer || quickReply) && !response.ok) {
                const body = await response.json().catch(() => null)
                const fallback = alternate ? 'Could not regenerate this reply. Try again.' : 'Could not send this message. Try again.'
                throw new Error(typeof body?.error === 'string' ? body.error : fallback)
            }
            if (answer) {
                if (response.headers.get('x-session-id') !== answer.sessionId || response.headers.get(answer.receiptHeader) !== answer.receiptId || !response.headers.get('x-run-id')) {
                    throw new Error('approvalId' in answer.payload ? 'Could not confirm your decisions. Retry the same decisions to check safely.' : 'Could not confirm your answer. Retry the same answer to check safely.')
                }
                answer.accepted = true
                answer.onAccepted?.()
            }
            if (quickReply) {
                if (response.headers.get('x-session-id') !== quickReply.sessionId || response.headers.get('x-run-id') !== quickReply.requestId) {
                    throw new Error('Could not confirm this suggested reply. Retry the same reply to check safely.')
                }
                quickReply.accepted = true
            }
        } catch (cause) {
            if (answer) answer.error = cause instanceof Error ? cause : new Error('approvalId' in answer.payload ? 'Could not send your decisions. Try again.' : 'Could not send your answer. Try again.')
            throw cause
        } finally {
            pendingAttachment.current = null
            pendingQueue.current = null
        }
        const id = response.headers.get('x-session-id')
        if (alternate && (!id || id === alternate.sessionId)) throw new Error('Could not open the alternate chat. Try again.')
        if (queued && (id !== queued.sessionId || response.headers.get('x-run-id') !== queued.item.id)) throw new Error(queueCopy.confirmFailed)
        if (response.ok && id) {
            if (queued) {
                try { await queued.acknowledge() } catch { setQueueNotice('receiptPending') }
                if (flushingQueue.current === queued.item.id) flushingQueue.current = null
            }
            if (pending?.documents) await documents.consumed(pending.documents).catch(() => setUploadNotice('The documents were sent. Reopen the chat to refresh their saved state.'))
            if (pending && draft.clear(pending.version)) {
                setInputs(current => current.get(pending.inputKey) === pending.input ? new Map(current).set(pending.inputKey, '') : current)
                setAttachments(current => {
                    if (!samePaths(current.get(pending.key) ?? [], pending.attachments)) return current
                    const next = new Map(current); next.delete(pending.key); return next
                })
            }
            if (alternate) {
                regenerationIds.current.delete(alternate.key)
                const alternateKey = JSON.stringify([alternate.agentId, id])
                setInputs(current => {
                    const next = new Map(current)
                    if (!next.has(alternate.draftKey)) {
                        next.set(alternate.draftKey, next.get('') ?? '')
                        next.delete('')
                    }
                    if (!next.has(alternateKey)) next.set(alternateKey, '')
                    return next
                })
            }
            // A new session gets its ID from the first response. Keep its live stream visible.
            setLiveSessionId(id)
            setLiveRunId(response.headers.get('x-run-id'))
            setHistory({ id })
            const bound = await onChatSession(id, alternate ? composer.current : undefined)
            if (alternate) {
                if (bound === false) draft.invalidate('Could not save the alternate chat. Reload open tabs before editing its draft.')
                else await draft.reload()
            }
        }
        return response
        } finally { pending?.release(); alternate?.release() }
    }, [agent.id, tabUid, onChatSession, draft.clear, draft.reload, draft.invalidate, documents.consumed, queueCopy.confirmFailed])

    // The constructor saves the callback; only a submitted request reads the pending draft.
    // eslint-disable-next-line react-hooks/refs
    const transport = useMemo(() => new DefaultChatTransport({
        api: '/api/desktop/chat',
        prepareSendMessagesRequest: ({ body, messages, trigger, messageId }) => ({
            body: trigger === 'regenerate-message' ? { ...body, regenerateMessageId: messageId } : { ...body, text: lastUserText(messages) },
        }),
        prepareReconnectToStreamRequest: () => {
            const target = resumeTarget.current
            if (!target) return { api: 'desktop-resume:unavailable' }
            return { api: `/api/desktop/sessions/${encodeURIComponent(target.sessionId)}/resume?runId=${encodeURIComponent(target.runId)}` }
        },
        fetch: async (url, init) => {
            const href = url instanceof Request ? url.url : String(url)
            if (href === 'desktop-resume:unavailable' || href.includes('/resume')) {
                if (href === 'desktop-resume:unavailable') throw new Error('This reply cannot be resumed. Nothing was sent again.')
                const response = await fetch(url, init)
                if (response.status === 204 || response.headers.get('x-rerun-resume') === 'unavailable') throw new Error('This reply cannot be resumed. Nothing was sent again.')
                if (!response.ok) {
                    const body = await response.json().catch(() => null)
                    throw new Error(typeof body?.error === 'string' ? body.error : 'This reply’s status is unavailable. Try again.')
                }
                return response
            }
            return sendToEngine(url, init)
        },
    }), [sendToEngine])

    const { messages, setMessages, sendMessage, regenerate, stop, status, error, clearError, resumeStream } = useChat({
        id: tabUid ? `desktop-${agent.id}-${tabUid}` : `desktop-${agent.id}`,
        transport,
        experimental_throttle: 60,
        onFinish: ({ isAbort, isDisconnect, isError }) => {
            if (!isAbort && !isDisconnect && !isError) completedRef.current = true
        },
    })

    const busy = serviceStreaming || status === 'submitted' || status === 'streaming'
    const resumeSession = useRef(sessionId)
    const resumeRun = useRef<string | null>(null)
    resumeSession.current = sessionId
    resumeRun.current = (liveSessionId === sessionId ? liveRunId : null) ?? (engineRunning.id === sessionId ? engineRunning.runId ?? null : null)
    const [reconnectNote, setReconnectNote] = useState<string | null>(null)
    const reconnecting = useRunReconnect({
        error,
        completedRef,
        start: () => {
            const currentSession = resumeSession.current
            const runId = resumeRun.current
            if (!currentSession || !runId) return null
            const target = { sessionId: currentSession, runId }
            resumeTarget.current = target
            const isCurrent = () => resumeTarget.current === target && resumeSession.current === currentSession
            return {
                runId,
                isCurrent,
                getRun: async () => {
                    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(currentSession)}/stop`, { cache: 'no-store' })
                    const body = await response.json().catch(() => null)
                    if (!response.ok || !body) return null
                    if (body.running === true) return { status: 'running' }
                    if (typeof body.failedRunError === 'string' && body.failedRunError) return { status: 'error', error: body.failedRunError }
                    if (typeof body.failedRunId === 'string') return { status: 'error', error: null }
                    return { status: 'done' }
                },
                fetchMessages: async () => (await historyFor(currentSession, AbortSignal.timeout(15000))).messages,
                onSettled: ({ errored, errorText }) => {
                    // Re-read the transcript and pending cards together before allowing a new turn.
                    setHistory(current => current.id === currentSession ? { id: currentSession } : current)
                    setAttempt(n => n + 1)
                    if (errored && errorText) setReconnectNote(errorText)
                },
            }
        },
        resumeStream,
        setMessages: setMessages as (messages: never[]) => void,
        clearError,
    })
    const inactive = agent.enabled === false
    // A matching session ID may still hold the snapshot from before a run or reload.
    // Only a complete snapshot from this read generation can acknowledge a finished reply.
    const historyReadKey = JSON.stringify([sessionId, busy, attempt])
    const historyRead = useRef({ key: historyReadKey, generation: 0 })
    if (historyRead.current.key !== historyReadKey) historyRead.current = { key: historyReadKey, generation: historyRead.current.generation + 1 }
    const historyGeneration = historyRead.current.generation

    const ready = history.id === sessionId && !history.error
    const runInFlight = !busy && engineRunning.id === sessionId && engineRunning.running
    const generating = busy || runInFlight
    useEffect(() => {
        if (!requestedPanel || requestedPanel.panel === 'desktop' || !active || requestedPanel.agentId !== agent.id || handledPanel.current === requestedPanel) return
        if (isDesktopQuitting()) return
        // A freshly restored chat has not yet checked whether its engine is still replying.
        // Keep Settings closed until that read belongs to this session; Back/Close cancels it.
        if (requestedPanel.panel === 'settings' && sessionId && !busy && engineRunning.id !== sessionId) {
            setCardOpen(true)
            setPanelNotice('Checking this chat’s reply status before opening settings…')
            setPanelFocus('card')
            return
        }
        handledPanel.current = requestedPanel
        onPanelRequestHandled?.(requestedPanel)
        setPanelNotice('')
        if (requestedPanel.panel === 'chat') { setDetailPanel(null); setCardOpen(false); setPanelFocus('chat'); return }
        if (requestedPanel.panel === 'actions') { setDetailPanel(null); setCardOpen(false); setPanelFocus(null); setNeedsRequest(requestedPanel.nonce); return }
        setCardOpen(true)
        if (requestedPanel.panel === 'settings' && generating) {
            setPanelNotice('Wait for this reply to finish before editing the coworker.')
            setPanelFocus('card')
            return
        }
        setPanelFocus(null)
        if (requestedPanel.panel === 'skills') setFocusedSkill(null)
        if (requestedPanel.panel === 'files') setFocusedFile(null)
        setDetailPanel(requestedPanel.panel)
    }, [requestedPanel, active, agent.id, sessionId, busy, engineRunning.id, generating, onPanelRequestHandled])
    useEffect(() => {
        if (!panelFocus || !active || detailPanel) return
        const selector = panelFocus === 'chat' ? 'textarea' : '[aria-label="Coworker card"]'
        conversationRoot.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
        setPanelFocus(null)
    }, [panelFocus, active, detailPanel, cardOpen])
    const dirty = voiceActivity.dirty || !draft.loaded || !uploadsLoaded || !!(input || attachmentPaths.length || queue.queued || uploadsActive || uploadItems.length || imageUploads.items.length || documents.attachments.length)
    const readable = active && !cardOpen && !detailPanel && !chatsOpen && ready && !generating && history.loadedGeneration === historyGeneration
        && !!history.transcript && history.question !== undefined && history.approval !== undefined && history.takeover !== undefined && history.serviceRequest !== undefined && history.secretRequest !== undefined && history.mcpSignIn !== undefined
        && engineRunning.id === sessionId
    useEffect(() => { if (tabUid) onTabActivity?.(tabUid, { busy: generating || voiceActivity.busy, dirty, recordingPending: voiceActivity.dirty, readableSessionId: readable ? sessionId : null }) }, [tabUid, generating, voiceActivity.busy, voiceActivity.dirty, dirty, readable, sessionId, onTabActivity])
    const question = history.id === sessionId ? history.question : undefined
    const approval = history.id === sessionId ? history.approval : undefined
    const takeover = history.id === sessionId ? history.takeover : undefined
    const [screenOpen, setScreenOpen] = useState<'manual' | 'request' | null>(null)
    const screenApi = useMemo(() => sessionId && takeover ? takeoverScreenApi(sessionId, takeover.id) : undefined, [sessionId, takeover?.id])
    useEffect(() => { setScreenOpen(null) }, [active, sessionId, takeover?.id])
    useEffect(() => {
        if (!requestedPanel || requestedPanel.panel !== 'desktop' || !active || agent.enabled === false || requestedPanel.agentId !== agent.id || handledPanel.current === requestedPanel || isDesktopQuitting()) return
        handledPanel.current = requestedPanel
        onPanelRequestHandled?.(requestedPanel)
        setDetailPanel(null); setCardOpen(false); setScreenOpen('manual')
    }, [requestedPanel, active, agent.id, agent.enabled, sessionId, onPanelRequestHandled])
    const serviceRequest = history.id === sessionId ? history.serviceRequest : undefined
    const secretRequest = history.id === sessionId ? history.secretRequest : undefined
    const mcpSignIn = history.id === sessionId ? history.mcpSignIn : undefined
    const mcpRequest = mcpSignIn?.request?.receipt?.accepted ? null : mcpSignIn?.request
    const webhookRequest = useDesktopWebhookRequest(agent.id, sessionId, active && !draft.quitting, attempt)
    const retainedWebhook = useRef<TriggerRequestView | null>(null)
    const streamingWebhook = serviceStreaming && !!serviceStream.current?.triggerRequestKind && serviceStream.current.agentId === agent.id && serviceStream.current.sessionId === sessionId
    if (!streamingWebhook) retainedWebhook.current = webhookRequest?.request && webhookRequest.link.kind !== 'signin' ? webhookRequest : null
    const wrappedWebhook = retainedWebhook.current?.link.agentId === agent.id && retainedWebhook.current.link.sessionId === sessionId ? retainedWebhook.current : null
    const webhookOwns = (kind: TriggerRequestView['link']['kind'], id: string | undefined) => !!wrappedWebhook && wrappedWebhook.link.kind === kind && wrappedWebhook.link.requestId === id
    const pendingRequest = question || approval || takeover || (serviceRequest ? { id: serviceRequest.serviceRequestId, toolCallId: serviceRequest.source.toolCallId } : null) || (secretRequest ? { id: secretRequest.requestId, toolCallId: secretRequest.source.toolCallId } : null) || (mcpRequest ? { id: mcpRequest.requestId, toolCallId: mcpRequest.source.toolCallId } : null)
    // Every pending request must be known before a later turn or an automatic queue flush.
    const requestBlocked = reconnecting || setupBlocked || !!sessionId && (question !== null || approval !== null || takeover !== null || serviceRequest !== null || secretRequest !== null || mcpSignIn === undefined || !!mcpRequest)
    const canRegenerate = draft.loaded && !draft.error && !draft.quitting && !quickReplyBusy && !requestBlocked && !inactive && !!sessionId && ready && !!history.transcript && engineRunning.id === sessionId && !generating && !stopping && !queue.queued && !queue.pending
    const feedback = useDesktopReplyFeedback(agent.id, sessionId, active)
    // The SDK can still report busy from the previous tab while the visible chat changes.
    const ownsLiveStop = !!sessionId && liveSessionId === sessionId
    const stopTarget = (busy ? ownsLiveStop : runInFlight) ? sessionId : null
    const stopRunId = stopTarget ? (busy ? liveRunId : engineRunning.runId) : null
    const historyError = history.id === sessionId ? history.error : undefined
    const savedFailure = history.id === sessionId ? replayedRunFailure(history.transcript ?? [], history.lastError ?? engineRunning.failedRunError ?? null) : null
    const stopBanner = reconnectNote || savedFailure || (!reconnecting ? error?.message : undefined)
    // The SDK throttles message updates. Show the verified snapshot immediately when switching,
    // even if its subscription still holds the previous chat's messages.
    const showSaved = ready && (!busy || regenerationSource === sessionId && !!sessionId)
    const transcript = showSaved ? history.transcript ?? messages : busy ? messages : []
    const { savedReceipts, answeredCalls } = useMemo(() => {
        const savedReceipts = new Map<string, NonNullable<ReturnType<typeof desktopSavedChatReceiptOf>>>()
        const answeredCalls = new Map<string, Set<string>>()
        for (const message of transcript) {
            const receipt = desktopSavedChatReceiptOf(message, agent.id, sessionId)
            if (!receipt) continue
            savedReceipts.set(message.id, receipt)
            const calls = answeredCalls.get(receipt.sourceMessageId) ?? new Set<string>()
            calls.add(receipt.sourceToolCallId)
            answeredCalls.set(receipt.sourceMessageId, calls)
        }
        return { savedReceipts, answeredCalls }
    }, [transcript, agent.id, sessionId])
    const latestAssistant = transcript.findLast(message => message.role === 'assistant')
    const streamingMessage = !showSaved && (status === 'streaming' || serviceStreaming) ? transcript.at(-1) : undefined
    const chatActivity = active && !reconnecting && !pendingRequest && generating
        ? <DesktopChatActivity agentId={agent.id} message={streamingMessage} />
        : null
    const proposalSourceIds = useMemo(() => desktopSkillProposalIds(transcript), [transcript])
    const proposalSessionId = sessionId ?? liveSessionId
    const proposalsActive = active && !cardOpen && !detailPanel && !!proposalSessionId && proposalSourceIds.size > 0
    const skillProposals = useCoworkerSkillProposals(agent.id, { sessionId: proposalSessionId ?? undefined, active: proposalsActive, mode: 'chat' })
    const proposalSourceKey = [...proposalSourceIds].join('\0')
    const previousProposalSource = useRef(proposalSourceKey)
    useEffect(() => {
        if (previousProposalSource.current === proposalSourceKey) return
        previousProposalSource.current = proposalSourceKey
        if (proposalsActive) void skillProposals.refresh()
    }, [proposalSourceKey, proposalsActive, skillProposals.refresh])
    const pinnedSkillProposals = skillProposals.pinned.filter(row => proposalSourceIds.has(row.id))
    const proposalScopeKey = JSON.stringify([agent.id, proposalSessionId, tabUid, proposalsActive])
    const proposalScope = useRef({ key: proposalScopeKey })
    if (proposalScope.current.key !== proposalScopeKey) proposalScope.current = { key: proposalScopeKey }
    const capturedProposalScope = proposalScope.current
    const openProposalSkill = (slug: string) => {
        if (proposalScope.current !== capturedProposalScope || !proposalsActive || isDesktopQuitting()) return
        if (![...skillProposals.proposals.values()].some(row => proposalSourceIds.has(row.id) && row.status === 'applied' && row.appliedSlug === slug)) return
        setFocusedSkill(slug); setCardOpen(true); setDetailPanel('skills')
    }

    useEffect(() => {
        if (busy) return
        const controller = new AbortController()
        const emptyHistory: DesktopHistoryRead = { messages: [], lastError: null, activeRunId: null, runsUnavailable: false }
        const read = sessionId ? Promise.all([historyFor(sessionId, controller.signal), questionFor(sessionId, controller.signal), approvalFor(sessionId, controller.signal), takeoverFor(sessionId, controller.signal), serviceRequestFor(sessionId, controller.signal), secretRequestFor(sessionId, controller.signal), readDesktopMcpSignIn(sessionId, { signal: controller.signal })]) : Promise.resolve([emptyHistory, null, null, null, null, null, null] as [DesktopHistoryRead, null, null, null, null, null, null])
        void read.then(([result, pending, approval, takeover, serviceRequest, secretRequest, mcpSignIn]) => {
            if (controller.signal.aborted) return
            if ([pending, approval, takeover, serviceRequest, secretRequest?.receipt ? null : secretRequest, mcpSignIn?.request?.receipt ? null : mcpSignIn?.request].filter(Boolean).length > 1) throw new Error('This conversation changed while loading. Reload it to see the current request.')
            setMessages(result.messages)
            setHistory({ id: sessionId, transcript: result.messages, question: pending, approval, takeover, serviceRequest, secretRequest, mcpSignIn, loadedGeneration: historyGeneration, lastError: result.lastError, activeRunId: result.activeRunId, runsUnavailable: result.runsUnavailable, runVersion: result.runVersion })
        }).catch(cause => {
            if (!controller.signal.aborted) setHistory({ id: sessionId, error: cause instanceof Error ? cause.message : 'Could not load history' })
        })
        return () => controller.abort()
    }, [sessionId, setMessages, busy, attempt, historyGeneration])

    useEffect(() => {
        setStopError(undefined)
    }, [sessionId, busy, ready, attempt])

    useEffect(() => {
        if (busy || !sessionId || !ready || history.loadedGeneration !== historyGeneration) return
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        let checking = false
        let refreshing = false
        let wasRunning = !!history.activeRunId
        const check = async () => {
            if (checking || refreshing || controller.signal.aborted || isDesktopQuitting()) return
            clearTimeout(timer)
            checking = true
            let unavailable = false
            try {
                const response = await fetch(stopUrl(sessionId), { signal: controller.signal })
                const body = await response.json().catch(() => ({}))
                if (controller.signal.aborted) return
                if (!response.ok) throw new Error('Run status unavailable')
                const running = body.running === true
                const runId = running && typeof body.runId === 'string' ? body.runId : null
                const failedRunId = typeof body.failedRunId === 'string' ? body.failedRunId : null
                const failedRunError = typeof body.failedRunError === 'string' ? body.failedRunError : null
                setEngineRunning(current => current.id === sessionId && current.running === running && current.runId === runId
                    && current.failedRunId === failedRunId && current.failedRunError === failedRunError
                    ? current : { id: sessionId, running, runId, failedRunId, failedRunError })
                const changed = typeof body.runVersion === 'string' && body.runVersion !== history.runVersion
                if (changed || !running && wasRunning) {
                    refreshing = true
                    setHistory(current => current.id === sessionId ? { ...current, question: undefined, approval: undefined, takeover: undefined, serviceRequest: undefined, secretRequest: undefined, mcpSignIn: undefined } : current)
                    setAttempt(n => n + 1)
                }
                wasRunning = running
            } catch {
                unavailable = true
            } finally {
                checking = false
                // Idle tabs read on foreground return. A run we already observed keeps its
                // completion check even if the user leaves the tab.
                if (!refreshing && !controller.signal.aborted && (wasRunning || unavailable || active && document.visibilityState !== 'hidden')) timer = setTimeout(check, RUN_POLL_MS)
            }
        }
        void check()
        const catchUp = () => {
            if (document.visibilityState !== 'hidden') void check()
            else if (!wasRunning) clearTimeout(timer)
        }
        if (active) {
            window.addEventListener('focus', catchUp)
            document.addEventListener('visibilitychange', catchUp)
        }
        return () => {
            controller.abort()
            clearTimeout(timer)
            window.removeEventListener('focus', catchUp)
            document.removeEventListener('visibilitychange', catchUp)
        }
    }, [sessionId, busy, ready, active, historyGeneration, history.loadedGeneration, history.activeRunId, history.runVersion])

    const resumedRun = useRef<string | null>(null)
    const wasActive = useRef(active)
    useEffect(() => {
        if (wasActive.current && !active) resumedRun.current = null
        wasActive.current = active
    }, [active])
    useEffect(() => {
        if (!active || busy || stopping || !sessionId || history.id !== sessionId || history.runsUnavailable || !history.activeRunId) return
        const key = `${sessionId}:${history.activeRunId}`
        if (resumedRun.current === key) return
        resumedRun.current = key
        resumeTarget.current = { sessionId, runId: history.activeRunId }
        // Resuming skips the send response that normally binds Stop to the live conversation.
        setLiveSessionId(sessionId)
        setLiveRunId(history.activeRunId)
        completedRef.current = false
        setReconnectNote(null)
        void resumeStream()
    }, [active, busy, stopping, sessionId, history.id, history.runsUnavailable, history.activeRunId, resumeStream])

    async function handleStop(): Promise<boolean> {
        const id = stopTarget
        if (!id || !stopRunId || stopping) return false
        setStopError(undefined)
        // Abort the renderer stream, then cancel the actual engine run (as upstream AgentChat.handleStop).
        setStopping(true)
        if (busy) {
            setEngineRunning({ id, running: true, runId: stopRunId })
            serviceStream.current?.cancelStream()
            stop()
        }
        try {
            const response = await fetch(stopUrl(id) + '?runId=' + encodeURIComponent(stopRunId), { method: 'POST' })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not stop this reply. Try again.')
            setEngineRunning({ id: null, running: false })
            setHistory(current => current.id === id ? { ...current, activeRunId: null, question: undefined, approval: undefined, takeover: undefined, serviceRequest: undefined, secretRequest: undefined, mcpSignIn: undefined } : current)
            setAttempt(n => n + 1)
            return true
        } catch (cause) {
            setStopError(cause instanceof Error ? cause.message : 'Could not stop this reply. Try again.')
            return false
        } finally {
            setStopping(false)
        }
    }

    const submissionKey = JSON.stringify([agent.id, tabUid, sessionId, active])
    const submissionScope = useRef({ key: submissionKey, epoch: 0 })
    if (submissionScope.current.key !== submissionKey) submissionScope.current = { key: submissionKey, epoch: submissionScope.current.epoch + 1 }
    const submissionMounted = useRef(true)
    useEffect(() => { submissionMounted.current = true; return () => { submissionMounted.current = false } }, [])
    const submissionCurrent = useRef({ active, input, draft, generating, busy, queue, liveRunId, engineRunning, inactive, stopping, ready, requestBlocked, pendingRequest, modelBlock })
    submissionCurrent.current = { active, input, draft, generating, busy, queue, liveRunId, engineRunning, inactive, stopping, ready, requestBlocked, pendingRequest, modelBlock }

    async function submit(event: React.FormEvent) {
        event.preventDefault()
        const text = composer.current.text.trim()
        if (!active || !draft.loaded || draft.error || isDesktopQuitting() || preparingSubmit.current || (requestBlocked && !generating) || !!pendingRequest || (responding.current && !(generating && responding.current.accepted)) || (quickReplyRequest.current && !(generating && quickReplyRequest.current.accepted)) || inactive || (!text && !attachmentPaths.length && !documents.attachments.length && !uploadsBusy()) || stopping || !ready || !queue.loaded || queue.pending || queue.error || regenerating.current || pendingAttachment.current) return
        if (modelBlock && !generating && !queue.queued) {
            resolveModelBlock(modelBlock)
            return
        }
        const intent = submissionScope.current
        const currentIntent = () => submissionMounted.current && submissionScope.current === intent && submissionCurrent.current.active && !isDesktopQuitting()
        preparingSubmit.current = true
        setPreparingSend(true)
        let handedOff = false
        let release: (() => void) | undefined
        try {
            // Enter mid-import is a request to send, not an error: the message waits for the last
            // import and leaves on its own. A refused or unresolved attachment still stops it,
            // since its path would point at a file the agent cannot open.
            if (!await settleUploads() || !currentIntent() || uploadsHaveBlocked()) return
            const current = submissionCurrent.current
            if (current.input !== input || current.inactive || current.stopping || !current.ready || current.pendingRequest
                || (current.requestBlocked && !current.generating) || !current.queue.loaded || current.queue.pending || current.queue.error
                || regenerating.current || pendingAttachment.current) return
            const hold = holdDraftAdmission()
            release = hold
            const snapshot = tabUid ? desktopDraftRecord(agent.id, tabUid).state : current.draft
            const version = snapshot.version
            if (!snapshot.loaded || snapshot.error || !await current.draft.flush() || !currentIntent() || uploadsBusy() || uploadsHaveBlocked()) return
            if ((tabUid ? desktopDraftRecord(agent.id, tabUid).state.version !== version : submissionCurrent.current.input !== input)) return
            const paths = [...(composer.current.attachments ?? [])]
            const mentionFields = trimDesktopCoworkerMentions(input, composer.current.coworkerMentions)
            const pick = !sessionId && conversationChoice.current?.session === null ? conversationChoice.current.pick : undefined
            const documentSend = tabUid ? await documents.settle(pick) : null
            if (!currentIntent()) return
            if (!text && !paths.length && !documentSend) return
            const live = submissionCurrent.current
            if (live.inactive || live.stopping || !live.ready || live.pendingRequest || (live.requestBlocked && !live.generating)
                || !live.queue.loaded || live.queue.pending || live.queue.error || regenerating.current || pendingAttachment.current) return
            if (live.generating || (live.queue.queued && draftQueues.current.has(live.queue.queued.id))) {
                const queuedPaths = live.queue.queued ? desktopQueuedAttachmentPaths(live.queue.queued) : []
                const sameDraft = !live.generating && live.queue.queued && live.queue.queued.text === text && samePaths(queuedPaths, paths) && JSON.stringify(live.queue.queued.coworkerMentions ?? []) === JSON.stringify(mentionFields.coworkerMentions ?? []) && JSON.stringify(live.queue.queued.documents ?? null) === JSON.stringify(documentSend?.selection ?? null)
                const item = sameDraft ? live.queue.queued : await live.queue.enqueue(text, paths, live.busy ? live.liveRunId : live.engineRunning.runId ?? null, mentionFields.coworkerMentions, documentSend?.selection).catch(() => null)
                if (!item) return
                if (documentSend) await documents.consumed(documentSend.selection)
                if (current.draft.clear(version)) {
                    setInputs(current => current.get(inputKey) === input ? new Map(current).set(inputKey, '') : current)
                    setAttachments(current => { const next = new Map(current); if (samePaths(current.get(draftKey) ?? [], paths)) next.delete(draftKey); return next })
                }
                draftQueues.current.delete(item.id)
                setQueueNotice(undefined)
                if (!live.generating && currentIntent()) setSendQueuedId(item.id)
                return
            }
            if (live.modelBlock) {
                resolveModelBlock(live.modelBlock)
                return
            }
            setLiveSessionId(null)
            setLiveRunId(null)
            const pending = { key: draftKey, inputKey, input, attachments: paths, version, documents: documentSend?.selection, release: hold }
            pendingAttachment.current = pending
            const attachmentFields = desktopAttachmentFieldsOf(paths)
            const body = { agentId: agent.id, sessionId: sessionId ?? undefined, ...(!sessionId && tabUid && { tabUid }), ...(pick && { modelChoice: pick }), ...(documentSend && { documents: documentSend.selection, ...(sessionId && { requestId: documentSend.selection.admissionId }) }), ...attachmentFields, ...desktopCoworkerMentionFieldsOf(mentionFields.coworkerMentions) }
            handedOff = true
            void sendMessage({ text, ...((paths.length || documentSend || mentionFields.coworkerMentions?.length) && { metadata: { ...(documentSend && { documents: documentSend.admission.references }), ...attachmentFields, ...desktopCoworkerMentionFieldsOf(mentionFields.coworkerMentions) } }) }, { body }).finally(() => {
                if (pendingAttachment.current === pending) pendingAttachment.current = null
                hold()
            })
        } catch (error) { setUploadNotice(error instanceof Error ? error.message : 'Could not prepare the message. Your draft is still saved.') }
        finally { preparingSubmit.current = false; if (submissionMounted.current) setPreparingSend(false); if (!handedOff) release?.() }
    }

    async function sendQueued(item: DesktopQueuedMessage) {
        if (!draft.loaded || draft.error || isDesktopQuitting() || quickReplyRequest.current || requestBlocked || responding.current || !sessionId || inactive || stopping || generating || !ready || pendingAttachment.current || regenerating.current || flushingQueue.current) return
        flushingQueue.current = item.id
        setSendQueuedId(null)
        setQueueNotice(undefined)
        try {
            const claimed = await queue.action('attempt', item.id)
            if (claimed?.id !== item.id || queueScope.current !== queue.key) return
            pendingQueue.current = { item, sessionId, acknowledge: () => queue.action('remove', item.id) }
            setLiveSessionId(null)
            setLiveRunId(null)
            clearError?.()
            const paths = desktopQueuedAttachmentPaths(item)
            const attachmentFields = desktopAttachmentFieldsOf(paths)
            await sendMessage({ text: item.text, ...((paths.length || item.coworkerMentions?.length) && { metadata: { ...attachmentFields, ...desktopCoworkerMentionFieldsOf(item.coworkerMentions) } }) }, {
                body: { agentId: agent.id, sessionId, text: item.text, requestId: item.id, ...(item.documents && { documents: item.documents }), ...attachmentFields, ...desktopCoworkerMentionFieldsOf(item.coworkerMentions) },
            })
        } catch {
            setQueueNotice('sendFailed')
        } finally {
            if (pendingQueue.current?.item.id === item.id) pendingQueue.current = null
            if (flushingQueue.current === item.id) flushingQueue.current = null
            setAttempt(n => n + 1)
        }
    }

    async function sendQueuedNow() {
        if (!draft.loaded || draft.error || isDesktopQuitting()) return
        const item = queue.queued
        if ((requestBlocked && !generating) || !!pendingRequest || (responding.current && !(generating && responding.current.accepted)) || (quickReplyRequest.current && !(generating && quickReplyRequest.current.accepted)) || !item || inactive || queue.pending || stopping || flushingQueue.current) return
        setQueueNotice(undefined)
        // Wait for the displayed run to stop. The flush effect also requires a fresh
        // idle status and pending-request snapshot in case another window began a reply.
        if (generating && !await handleStop()) return
        clearError?.()
        setStopError(undefined)
        queue.adopt(item.id)
        setSendQueuedId(item.id)
    }

    const activeRunId = busy ? liveRunId : engineRunning.id === sessionId ? engineRunning.runId ?? null : null
    const queueStatusKnown = busy ? !!liveRunId : !sessionId || engineRunning.id === sessionId
    useEffect(() => {
        const item = queue.queued
        if (!draft.loaded || draft.error || draft.quitting || !active || !item || !queue.loaded || queue.pending || !ready || stopping || !queueStatusKnown || (item.id !== queue.restoredId && item.state !== 'review') || flushingQueue.current) return
        if (item.state === 'waiting' && shouldKeepQueued(item, activeRunId)) { queue.adopt(item.id); return }
        const key = queue.key + item.id
        if (restoredQueues.current.has(key)) return
        restoredQueues.current.add(key)
        const isCurrent = () => queueScope.current === queue.key && !isDesktopQuitting()
        const restoreDraft = async () => {
            const paths = desktopQueuedAttachmentPaths(item)
            const reviewed = await queue.action('review', item.id)
            // A different window may have removed or replaced the queue while this write was pending.
            if (!isCurrent() || reviewed?.id !== item.id || reviewed.state !== 'review') return
            if (composer.current.text.trim() === item.text && samePaths(draftPaths(composer.current), paths) && JSON.stringify(trimDesktopCoworkerMentions(composer.current.text, composer.current.coworkerMentions).coworkerMentions ?? []) === JSON.stringify(item.coworkerMentions ?? [])) draftQueues.current.add(item.id)
            // An older waiting message must not replace a newer draft already in the composer.
            if (!item.documents && !composer.current.text && draftPaths(composer.current).length === 0) {
                draftQueues.current.add(item.id)
                setInputs(current => new Map(current).set(draftKey, item.text))
                setAttachments(current => { const next = new Map(current); if (paths.length) next.set(draftKey, paths); else next.delete(draftKey); return next })
                composer.current = { text: item.text, attachments: paths, coworkerMentions: item.coworkerMentions }
                setMentionValues(current => new Map(current).set(draftKey, item.coworkerMentions ?? []))
                draft.update({ text: item.text, coworkerMentions: item.coworkerMentions ?? [], ...desktopAttachmentFieldsOf(paths) })
            }
            setQueueNotice('review')
        }
        void (async () => {
            if (item.state === 'sending' && sessionId) {
                // A restart may have lost only the HTTP acknowledgement. Reconcile the exact
                // request before offering its draft again; this probe can never create a run.
                const response = await fetch('/api/desktop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                    agentId: agent.id, sessionId, text: item.text, requestId: item.id, reconcileOnly: true, ...(item.documents && { documents: item.documents }), ...desktopCoworkerMentionFieldsOf(item.coworkerMentions),
                    ...desktopAttachmentFieldsOf(desktopQueuedAttachmentPaths(item)),
                }) })
                if (response.ok && response.headers.get('x-session-id') === sessionId && response.headers.get('x-run-id') === item.id) {
                    await response.body?.cancel()
                    await queue.action('remove', item.id)
                    if (isCurrent()) setAttempt(n => n + 1)
                    return
                }
                if (response.status !== 404) {
                    if (isCurrent()) setQueueNotice('checkFailed')
                    return
                }
            }
            await restoreDraft()
        })().catch(() => { if (isCurrent()) setQueueNotice('restoreFailed') })
    }, [active, activeRunId, agent.id, draftKey, queue, queueStatusKnown, ready, sessionId, stopping, draft.loaded, draft.error, draft.quitting, draft.update])

    const queued = queue.queued
    const queueFeedback = queueNotice === 'receiptPending' ? queueNotice : queue.error ?? queueNotice
    const queuedBehindFailure = !!queued?.behindRunId && queued.behindRunId === engineRunning.failedRunId
    const canFlushQueue = draft.loaded && !draft.error && !draft.quitting && !requestBlocked && !inactive && !!sessionId && ready && modelReady && queue.loaded && !queue.pending && !queue.restoredId && queueStatusKnown && !stopping && !stopError && !queue.error
        && shouldFlush({ queued, busy: generating, uploading: !!pendingAttachment.current || !!regenerating.current, status, hasError: !!error || !!queueNotice || queuedBehindFailure })
    useEffect(() => {
        if (!draft.loaded || draft.error || draft.quitting || requestBlocked || !queued || queue.pending || !ready || !modelReady || !queueStatusKnown || inactive || generating || stopping || flushingQueue.current) return
        if (sendQueuedId === queued.id || (canFlushQueue && queued.state === 'waiting')) void sendQueued(queued)
    })

    async function regenerateReply(messageId: string) {
        if (quickReplyRequest.current || !canRegenerate || !sessionId || !history.transcript || regenerating.current || pendingAttachment.current) return
        if (tabUid && onStartFork && !onStartFork(tabUid)) return
        const key = JSON.stringify([sessionId, messageId])
        const requestId = regenerationIds.current.get(key) ?? crypto.randomUUID()
        regenerationIds.current.set(key, requestId)
        const release = holdDraftAdmission()
        regenerating.current = { key, agentId: agent.id, sessionId, draftKey, release }
        setRegenerationSource(sessionId)
        setLiveSessionId(null)
        try {
            if (!await draft.flush() || isDesktopQuitting()) return
            setMessages(history.transcript)
            await regenerate({ messageId, body: { agentId: agent.id, sessionId, requestId } })
        } finally {
            release()
            if (tabUid) onFinishFork?.(tabUid)
            regenerating.current = null
            setRegenerationSource(null)
            setAttempt(n => n + 1)
        }
    }

    async function answerQuestion(payload: DesktopQuestionAnswer) {
        if (isDesktopQuitting()) throw new Error('Rerun is saving drafts before quitting.')
        if (quickReplyRequest.current || !active || !sessionId || !question || payload.questionId !== question.id || inactive || generating || stopping || !ready || responding.current || flushingQueue.current || regenerating.current) throw new Error('This question is not ready for an answer. Try again.')
        const answer = { sessionId, payload, url: questionUrl(sessionId), receiptHeader: 'x-question-id', receiptId: payload.questionId, accepted: false, error: undefined as Error | undefined }
        responding.current = answer
        setLiveSessionId(null)
        setLiveRunId(null)
        clearError?.()
        const text = payload.action === 'cancel' ? HITL_CANCELLED.question : serializeAnswers(question.questions.map((item, index) => ({ question: item.question, answers: payload.answers[index] ?? [] })))
        try {
            // The server reconstructs the answer from its saved question. The ordinary draft is kept.
            await sendMessage({ text }, { body: payload })
            if (!answer.accepted) throw answer.error ?? new Error('Could not confirm your answer. Try again.')
        } finally {
            if (responding.current === answer) responding.current = null
            setAttempt(n => n + 1)
        }
    }

    async function decideApproval(payload: DesktopApprovalAnswer) {
        if (isDesktopQuitting()) throw new Error('Rerun is saving drafts before quitting.')
        if (quickReplyRequest.current || !active || !sessionId || !approval || payload.approvalId !== approval.id || inactive || generating || stopping || !ready || responding.current || flushingQueue.current || regenerating.current || pendingAttachment.current) throw new Error('This approval request is not ready. Try again.')
        const answer = { sessionId, payload, url: approvalUrl(sessionId), receiptHeader: 'x-approval-id', receiptId: payload.approvalId, accepted: false, error: undefined as Error | undefined }
        responding.current = answer
        setLiveSessionId(null)
        setLiveRunId(null)
        clearError?.()
        const text = serializeApprovalDecisions(approval.approvals.map((item, index) => ({ ...item, ...payload.decisions[index] })))
        try {
            // Only indexed decisions travel to the API. It reconstructs the authoritative actions.
            await sendMessage({ text }, { body: payload })
            if (!answer.accepted) throw answer.error ?? new Error('Could not confirm your decisions. Retry the saved decisions.')
        } finally {
            if (responding.current === answer) responding.current = null
            setAttempt(n => n + 1)
        }
    }

    async function decideTakeover(payload: DesktopTakeoverTerminal) {
        if (isDesktopQuitting() || !active || !sessionId || !takeover || takeover.id !== payload.takeoverId || inactive || generating || stopping || !ready || responding.current) throw new Error('This browser request is not ready. Try again.')
        let confirm!: () => void, fail!: (error: unknown) => void
        const accepted = new Promise<void>((resolve, reject) => { confirm = resolve; fail = reject })
        const answer = { sessionId, payload, url: takeoverUrl(sessionId), receiptHeader: 'x-takeover-id', receiptId: takeover.id, accepted: false, onAccepted: confirm, error: undefined as Error | undefined }
        responding.current = answer
        setLiveSessionId(null); setLiveRunId(null); clearError?.()
        // The server derives the verified URL and exact follow-up from its saved lease receipt.
        void sendMessage({ text: payload.action === 'skip' ? HITL_CANCELLED.takeover : 'Finished the browser takeover.' }, { body: payload }).then(() => {
            if (!answer.accepted) fail(answer.error ?? new Error('Could not confirm the browser decision. Retry it.'))
        }).catch(fail).finally(() => { if (responding.current === answer) responding.current = null; setAttempt(n => n + 1) })
        return accepted
    }

    const voiceSent = (result: DesktopVoiceSendReceipt & { text: string }) => {
        if (!result.dispatch || !active || isDesktopQuitting()) { setAttempt(value => value + 1); return }
        const { sessionId: acceptedSessionId, runId } = result.dispatch
        // The voice endpoint already admitted this exact turn. Attach to its stream only.
        void sendMessage({ text: result.text }, { body: {
            agentId: agent.id, ...(result.draft.scope.sessionId ? { sessionId: acceptedSessionId, requestId: runId, reconcileOnly: true } : { tabUid: result.draft.scope.tabUid, ...(result.draft.sendModelChoice && { modelChoice: result.draft.sendModelChoice }) }),
        } }).catch(() => { setAttempt(value => value + 1) })
    }

    const adoptServiceResponse = async (result: AcceptedService) => {
        const owns = () => serviceOwner.current.agentId === result.agentId && serviceOwner.current.sessionId === result.sessionId && serviceOwner.current.active
        if (!owns() || serviceStream.current) { result.cancelStream(); throw new Error('This conversation is no longer active.') }
        serviceStream.current = result
        setHistory(current => current.id === result.sessionId ? {...current, ...(result.triggerRequestKind === 'question' ? { question: null } : result.triggerRequestKind === 'approval' ? { approval: null } : result.triggerRequestKind === 'takeover' ? { takeover: null } : result.mcpSignInRequestId ? { mcpSignIn: null } : result.secretRequestId ? { secretRequest: null } : { serviceRequest: null })} : current)
        setMessages(history.transcript ?? messages)
        setServiceStreaming(true); setLiveSessionId(result.sessionId); setLiveRunId(result.requestId)
        try {
            for await (const message of readUIMessageStream<UIMessage>({stream:new AcceptedResponseDecoder().decode(result.response),terminateOnError:true})) {
                if(!owns() || serviceStream.current!==result){result.cancelStream();return}
                setMessages(previous=>previous.some(item=>item.id===message.id)?previous.map(item=>item.id===message.id?message:item):[...previous,message])
            }
        } catch(cause) {
            if(owns() && !result.signal.aborted)setStopError(cause instanceof Error?cause.message:'Could not read the accepted reply. Reload this chat.')
        } finally {
            if(serviceStream.current===result){serviceStream.current=null;setServiceStreaming(false);setAttempt(value=>value+1)}
        }
    }
    const adoptWebhookResponse = async (response: Response, view: TriggerRequestView) => {
        const runId = response.headers.get('x-run-id')
        if (!serviceOwner.current.active || serviceOwner.current.agentId !== view.link.agentId || serviceOwner.current.sessionId !== view.link.sessionId || response.headers.get('x-session-id') !== view.link.sessionId || response.headers.get('x-trigger-request-key') !== view.key || !runId || !response.body) {
            void response.body?.cancel().catch(() => {}); throw new Error('Webhook reply belongs to another request.')
        }
        // This response already represents the admitted continuation. Own its reader and adopt it directly.
        const controller = new AbortController(), reader = response.body.getReader()
        const cancelStream = () => { controller.abort(); void reader.cancel().catch(() => {}) }
        const stream = new ReadableStream<Uint8Array>({
            async pull(target) {
                try { const part = await reader.read(); if (controller.signal.aborted || part.done) target.close(); else target.enqueue(part.value) }
                catch (error) { target.error(error) }
            },
            cancel() { cancelStream() },
        })
        try {
            await adoptServiceResponse({ agentId: view.link.agentId, sessionId: view.link.sessionId, serviceRequestId: view.link.requestId, requestId: runId,
                triggerRequestKind: view.link.kind, ...(view.link.kind === 'secret' && { secretRequestId: view.link.requestId }),
                response: new Response(stream, { status: response.status, headers: response.headers }), signal: controller.signal, cancelStream })
        } finally { cancelStream(); try { reader.releaseLock() } catch { /* A pending reader cancellation owns release. */ } }
    }
    const renderWebhook = (screen?: ReactNode, live?: boolean) => wrappedWebhook && <DesktopWebhookHumanRequest initial={wrappedWebhook}
        active={active && !draft.quitting && !inactive && (!generating || streamingWebhook) && !stopping && ready} onAccepted={adoptWebhookResponse} onOpenApps={openServiceApps}
        onOpenResult={async target => {
            if (!serviceOwner.current.active || target.agentId !== agent.id || target.sessionId !== sessionId) throw new Error('Webhook result chat changed.')
            onSelectSession(target.sessionId)
        }}
        takeover={{ screen, live, onAction: async (request, input) => {
            if (!active || request.id !== takeover?.id || request.id !== wrappedWebhook.link.requestId) throw new Error('Browser request changed.')
            if (input.action === 'open') { setScreenOpen('request'); return }
            throw new Error('Use the existing browser viewer to release input.')
        } }} />
    useEffect(()=>{if(!busy)void setup.refresh()},[busy, attempt, setup.refresh])
    const lastMessage = transcript.at(-1)
    const quickReplyErrorIsRetryable = !!lastMessage && quickReplyRetry === lastMessage.id
    const quickRepliesVisible = active && !!sessionId && !requestBlocked && !generating && !stopping
        && !historyError && (!error || quickReplyErrorIsRetryable) && !stopError && !queue.error && !queueNotice
    const canSendQuickReply = !draft.quitting && quickRepliesVisible && !inactive && ready && modelReady && queueStatusKnown
        && queue.loaded && !queue.pending && !queue.queued && !queue.restoredId && !quickReplyBusy
    quickReplyContext.current = { scope: draftKey, messageId: lastMessage?.id, canSend: canSendQuickReply }

    async function sendQuickReply(messageId: string, text: string): Promise<boolean> {
        if (isDesktopQuitting()) return false
        const current = quickReplyContext.current
        // A retained callback must still belong to the visible chat's last assistant message.
        if (!sessionId || !history.transcript || current.scope !== draftKey || current.messageId !== messageId || !current.canSend
            || !lastMessage || lastMessage.role !== 'assistant' || !desktopQuickRepliesOf(lastMessage).includes(text)
            || quickReplyRequest.current || responding.current || pendingAttachment.current || regenerating.current || flushingQueue.current) return false
        const key = JSON.stringify([agent.id, sessionId, messageId, text])
        const requestId = quickReplyIds.current.get(key) ?? crypto.randomUUID()
        quickReplyIds.current.set(key, requestId)
        const request = { sessionId, requestId, accepted: false }
        quickReplyRequest.current = request
        setQuickReplyBusy(true)
        setQuickReplyRetry(null)
        setLiveSessionId(null)
        setLiveRunId(null)
        clearError?.()
        try {
            // Drop any optimistic user row left by a failed SDK transport before retrying.
            // The verified snapshot belongs to this idle, currently selected suggestion.
            setMessages(history.transcript)
            // The suggestion is its own message: preserve the ordinary text and file draft.
            await sendMessage({ text }, { body: { agentId: agent.id, sessionId, requestId } })
            return request.accepted
        } finally {
            if (quickReplyRequest.current === request) {
                quickReplyRequest.current = null
                setQuickReplyBusy(false)
                if (quickReplyContext.current.scope === draftKey) setQuickReplyRetry(request.accepted ? null : messageId)
                setAttempt(n => n + 1)
            }
        }
    }

    const uploadDisabled = !active || inactive || stopping || !ready || queue.pending || !draft.loaded || !uploadsLoaded || (!!draft.error && !draft.attachmentRejected) || !!regenerationSource || draft.quitting || !!pendingRequest || preparingSend
    uploadGate.current = uploadDisabled
    const composerForm = useRef<HTMLFormElement>(null)
    const uploadFileInput = useRef<HTMLInputElement>(null)
    const findTranscript = useRef<HTMLDivElement>(null)
    const [findOpen, setFindOpen] = useState(false)
    const [editorOpen, setEditorOpen] = useState(false)
    const transcriptActive = active && !cardOpen && !detailPanel && !chatsOpen
    const canFind = transcriptActive && !editorOpen
    const finding = findOpen && canFind
    const [editorSession, setEditorSession] = useState(0)
    const expandable = isLongMessage(input)
    useEffect(() => {
        if (!canFind) return
        const openFind = (event: Event) => {
            if (event.defaultPrevented) return
            event.preventDefault()
            setFindOpen(true)
        }
        window.addEventListener('rerun-desktop-conversation-find', openFind)
        return () => window.removeEventListener('rerun-desktop-conversation-find', openFind)
    }, [canFind])

    function closeFind() {
        setFindOpen(false)
        const form = composerForm.current
        if (!canFind || !form || form.hidden) return
        form.querySelector<HTMLTextAreaElement>('textarea:not([disabled])')?.focus({ preventScroll: true })
    }
    const [uploadDragOver, setUploadDragOver] = useState(false)
    useEffect(() => {
        const form = composerForm.current
        if (!form) return
        let depth = 0
        const hasFiles = (event: DragEvent) => event.dataTransfer?.types?.includes('Files') ?? false
        const onDragEnter = (event: DragEvent) => { if (!hasFiles(event)) return; depth += 1; setUploadDragOver(true) }
        const onDragLeave = (event: DragEvent) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (depth === 0) setUploadDragOver(false) }
        const onDragOver = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault() }
        const onDrop = (event: DragEvent) => {
            if (hasFiles(event)) event.preventDefault()
            depth = 0
            setUploadDragOver(false)
            if (!event.dataTransfer) return
            // Capture files and their owner synchronously. No recursive directory walk can
            // resolve later into a different tab or read unbounded folders before the cap.
            const items = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file')
                .map(item => ({ item, entry: item.webkitGetAsEntry?.() }))
            const folders = items.flatMap(({ entry }) => entry?.isDirectory
                ? [{ name: entry.name, message: 'Choose individual files to attach.' }] : [])
            const files = folders.length ? items.flatMap(({ item, entry }) => {
                const file = entry?.isDirectory ? null : item.getAsFile()
                return file ? [file] : []
            }) : Array.from(event.dataTransfer.files)
            beginUpload(files, formatFxAttachmentRejections(folders))
        }
        form.addEventListener('dragenter', onDragEnter)
        form.addEventListener('dragleave', onDragLeave)
        form.addEventListener('dragover', onDragOver)
        form.addEventListener('drop', onDrop)
        return () => {
            form.removeEventListener('dragenter', onDragEnter)
            form.removeEventListener('dragleave', onDragLeave)
            form.removeEventListener('dragover', onDragOver)
            form.removeEventListener('drop', onDrop)
        }
    }, [beginUpload])
    const blockedUploads = [...uploadItems, ...imageUploads.items].filter(item => item.status === 'error' || item.status === 'unresolved')
    const failedUploads = blockedUploads.filter(item => item.status === 'error').length
    const unknownUploads = blockedUploads.length - failedUploads
    const blockedUploadNotice = [
        failedUploads ? `${failedUploads} attachment${failedUploads > 1 ? 's' : ''} failed to import. Retry or remove ${failedUploads > 1 ? 'them' : 'it'} before sending.` : '',
        unknownUploads ? `${unknownUploads} attachment${unknownUploads > 1 ? 's' : ''} may already be in this coworker’s Files. Check Files, then dismiss ${unknownUploads > 1 ? 'these upload statuses' : 'this upload status'} before sending.` : '',
    ].filter(Boolean).join(' ')

    const canSendStarter = active && !input && !attachmentPaths.length && !documents.attachments.length
        && draft.loaded && !draft.error && !draft.quitting && !requestBlocked && !pendingRequest
        && !inactive && !stopping && !preparingSend && !voiceActivity.busy && !voiceActivity.dirty && !regenerationSource
        && queue.loaded && !queue.queued && !queue.pending && !queue.error
        && uploadsLoaded && !uploadsActive && !blockedUploads.length
    const sendStarter = (text: string) => {
        if (!canSendStarter || !composerForm.current || composer.current.text || isDesktopQuitting()) return
        // Use the normal form after the draft update is visible to its submission guard.
        flushSync(() => setInput(text))
        composerForm.current?.requestSubmit()
    }

    const lastUserIndex = transcript.findLastIndex(message => message.role === 'user')
    const savedRetryAnswer = lastUserIndex < 0 ? undefined : transcript.findLast((message, index) =>
        index > lastUserIndex && message.role === 'assistant' && message.id.startsWith('engine-'))
    const terminalUser = lastUserIndex >= 0 && lastUserIndex === transcript.length - 1 ? transcript[lastUserIndex] : undefined
    const retryMetadata = terminalUser?.metadata
    const plainRetry = retryMetadata == null || typeof retryMetadata === 'object' && !Array.isArray(retryMetadata)
        && Object.keys(retryMetadata).every(key => key === 'createdAt' || key === 'authorId')
    // The raw text path cannot reconstruct attachment, mention, or voice authority.
    const retryText = terminalUser && plainRetry && terminalUser.parts.every(part => part.type === 'text') ? lastUserText(transcript) : ''
    const canRetry = active && canRegenerate && !pendingRequest && !uploadsActive && !preparingSend
        && !regenerationSource && !history.runsUnavailable
        && (!!savedRetryAnswer || modelReady && !!retryText && !parseVoiceMessage(retryText))
    const recovery = useDesktopChatRecovery({
        scope: { agentId: agent.id, tabUid: tabUid ?? null, sessionId, liveSessionId: liveSessionId ?? sessionId, runId: engineRunning.id === sessionId ? engineRunning.runId ?? null : null, requestId: null, modelRevision },
        error: reconnecting ? null : error?.message ?? null,
        failedRun: engineRunning.id === sessionId && engineRunning.failedRunId ? { runId: engineRunning.failedRunId, error: engineRunning.failedRunError ?? null } : null,
        canRetry,
        active,
        ports: {
            retryLastTurn: async () => {
                if (!canRetry || !sessionId || isDesktopQuitting() || preparingSubmit.current
                    || uploadsBusy() || pendingAttachment.current || regenerating.current || quickReplyRequest.current) return
                if (savedRetryAnswer) return regenerateReply(savedRetryAnswer.id)
                preparingSubmit.current = true
                const release = holdDraftAdmission()
                try {
                    await sendMessage({ text: retryText }, { body: { agentId: agent.id, sessionId } })
                } finally {
                    preparingSubmit.current = false
                    release()
                }
            },
            continueRun: () => { if (sessionId) void sendMessage({ text: 'Continue where you left off.' }, { body: { agentId: agent.id, sessionId } }) },
            stopRun: () => { void handleStop() },
            newConversation: () => onSelectSession(null, 'New conversation'),
            switchModel: () => setOpenModelRequest(value => value + 1),
            reconnectProvider: () => onOpenModelSettings?.(),
        },
    })
    const composerId = !active && tabUid ? `desktop-message-${tabUid}` : 'desktop-message'
    const currentTitle = sessions.find(session => session.id === sessionId)?.title ?? 'New conversation'
    const generalView = tabUid === generalTabUid(agent.id)
    const threadCards = generalView ? sessions.filter(session => session.agentId === agent.id && session.kind !== 'general' && session.id !== sessionId) : []
    const { messageTimes, timeBreaks } = useMemo(() => {
        const messageTimes = transcript.map(({ metadata }) =>
            metadata && typeof metadata === 'object' && 'createdAt' in metadata && typeof metadata.createdAt === 'string' ? metadata.createdAt : '')
        return { messageTimes, timeBreaks: timeBreaksOf(messageTimes) }
    }, [transcript])
    const threadRows = generalView ? threadsByMessage(messageTimes, threadCards) : { leading: [], after: new Map<number, typeof threadCards>() }
    const conversationScroll = useRef<ConversationHandle | null>(null)
    const requestCards: { key: string; node: ReactNode; cue?: { kind: HitlKind; label: string } }[] = []
    const addRequest = (key: string, node: ReactNode, cue?: { kind: HitlKind; label: string }) => {
        requestCards.push({ key, node, cue })
    }
    const webhookCue = (request: TriggerRequestForm): { kind: HitlKind; label: string } => {
        switch (request.kind) {
            case 'question': return { kind: 'question', label: t('chatRequestCue.question', { count: request.value.questions.length }) }
            case 'approval': return { kind: 'approval', label: t('chatRequestCue.approval', { count: request.value.approvals.length }) }
            case 'service': return { kind: 'service', label: t('chatRequestCue.service', { count: request.value.services.length }) }
            case 'secret': return { kind: 'secret', label: t('chatRequestCue.secret', { count: request.value.fields.length }) }
            case 'takeover': return { kind: 'takeover', label: t('chatRequestCue.takeover') }
            case 'signin': return { kind: 'mcp', label: t('chatRequestCue.mcpNamed', { name: request.value.name }) }
        }
    }
    if (active && wrappedWebhook) {
        const request = wrappedWebhook.request
        const waiting = request && wrappedWebhook.phase === 'pending' && wrappedWebhook.availability === 'ready' && wrappedWebhook.runStatus === 'done'
        addRequest(`webhook:${wrappedWebhook.key}`, request?.kind === 'takeover'
            ? <DesktopBrowserCard agentId={agent.id} takeover={request.value} disabled onAction={async () => {}} renderCard={renderWebhook} />
            : renderWebhook(), waiting ? webhookCue(request) : undefined)
    }
    if (serviceRequest && sessionId && !webhookOwns('service', serviceRequest.serviceRequestId)) {
        addRequest(`service:${serviceRequest.serviceRequestId}`,
            <DesktopServiceRequestBlock agentId={agent.id} sessionId={sessionId} request={serviceRequest} inline disabled={draft.quitting || !active || inactive || generating || stopping || !ready} onOpenApps={openServiceApps} onAccepted={adoptServiceResponse} />,
            serviceRequest.retry.phase === 'accepted' ? undefined : { kind: 'service', label: t('chatRequestCue.service', { count: serviceRequest.services.length }) })
    }
    if (mcpRequest && sessionId) {
        addRequest(`mcp:${mcpRequest.requestId}`,
            <DesktopMcpSignInBlock sessionId={sessionId} request={mcpRequest} initialOAuth={mcpSignIn?.oauth} inline active={!draft.quitting && active && !inactive && !generating && !stopping && ready} onAccepted={(response, stream) => adoptServiceResponse({
                agentId: agent.id, sessionId, serviceRequestId: mcpRequest.requestId, mcpSignInRequestId: mcpRequest.requestId,
                requestId: response.headers.get('x-run-id')!, response, ...stream,
            })} />, { kind: 'mcp', label: t('chatRequestCue.mcpNamed', { name: mcpRequest.source.server.displayName }) })
    }
    if (secretRequest && sessionId && !webhookOwns('secret', secretRequest.requestId)) {
        addRequest(`secret:${secretRequest.requestId}`,
            <DesktopSecretRequestBlock sessionId={sessionId} request={secretRequest} inline active={!draft.quitting && active && (!inactive || !!secretRequest.receipt) && !generating && !stopping && ready} onAccepted={(response, stream) => adoptServiceResponse({
                agentId: agent.id, sessionId, serviceRequestId: secretRequest.requestId, secretRequestId: secretRequest.requestId,
                requestId: response.headers.get('x-run-id')!, response, ...stream,
            })} />, secretRequest.status === 'accepted' ? undefined : { kind: 'secret', label: t('chatRequestCue.secret', { count: secretRequest.fields.length }) })
    }
    if (question && !webhookOwns('question', question.id)) {
        addRequest(`question:${question.id}`, <DesktopQuestionCard question={question}
            voiceTarget={!cardOpen && !detailPanel && !chatsOpen && sessionId ? { sessionId } : undefined}
            documentScope={sessionId ? { agentId: agent.id, sessionId, tabUid: questionDocumentTabUid(question.id) } : undefined}
            disabled={draft.quitting || !active || inactive || generating || stopping || !ready} onAnswer={answerQuestion} />,
        { kind: 'question', label: t('chatRequestCue.question', { count: question.questions.length }) })
    }
    if (approval && !webhookOwns('approval', approval.id)) {
        addRequest(`approval:${approval.id}`,
            <DesktopApprovalCard approval={approval} disabled={draft.quitting || !active || inactive || generating || stopping || !ready} onDecide={decideApproval} />,
            { kind: 'approval', label: t('chatRequestCue.approval', { count: approval.approvals.length }) })
    }
    if (active && takeover && !webhookOwns('takeover', takeover.id)) {
        addRequest(`takeover:${takeover.id}`,
            <DesktopBrowserCard agentId={agent.id} takeover={takeover} disabled={draft.quitting || inactive || generating || stopping || !ready} onAction={async payload => {
                if (payload.action === 'open') { setScreenOpen('request'); return }
                if (payload.action === 'done' || payload.action === 'skip') await decideTakeover(payload)
            }} />, { kind: 'takeover', label: t('chatRequestCue.takeover') })
    }
    const waitingCard = ready && !generating && !stopping && !draft.quitting
        ? requestCards.find(card => card.cue) : undefined
    const cueKey = waitingCard ? JSON.stringify([workspaceId, agent.id, sessionId, tabUid, waitingCard.key]) : null
    const pendingBlock = useArriveByTop(conversationScroll, cueKey, arrival, transcriptActive)
    const lastArrival = useRef<DesktopChatRequest | null>(null)
    useEffect(() => {
        const conversation = conversationScroll.current
        if (!arrival || arrival === lastArrival.current || !transcriptActive || !ready || !conversation) return
        lastArrival.current = arrival
        if (pendingBlock.current) bringBlockIn(conversation, pendingBlock.current, 'instant')
        else void conversation.scrollToBottom('instant')
    }, [arrival, pendingBlock, ready, transcriptActive])

    const pendingCue = waitingCard?.cue && cueKey ? {
        key: cueKey, blockRef: pendingBlock,
        summary: summarizePendingHitl(waitingCard.cue.kind, {}, waitingCard.cue.label),
        jumpLabel: t('jumpToChatRequest', { label: waitingCard.cue.label }),
        focusOnJump: true,
    } : null
    const placeholder = generalView ? t('message', { name: agent.name }) : sessionId && currentTitle !== 'New conversation' ? t('reply', { title: currentTitle }) : t('sendMessage')
    return (
        <div ref={conversationRoot} className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col bg-background" onKeyDown={event => {
            if (cardOpen && event.key === 'Escape' && !event.defaultPrevented && !(event.target as HTMLElement).closest('[role="dialog"], [role="alertdialog"]')) {
                event.preventDefault()
                event.stopPropagation()
                overviewCloseControl.requestClose(() => { dismissCard(); setPanelFocus('card') })
            }
        }}>
            <header inert={overviewCovered} className={cn('relative z-40 grid shrink-0 grid-cols-[minmax(2.5rem,1fr)_minmax(0,max-content)_minmax(2.5rem,1fr)] items-center gap-1 px-3 pt-3', overviewCovered && 'invisible [&_button]:backdrop-filter-none')}>
                <div className="flex min-w-0 items-center justify-start">
                    {renderHistory ? renderHistory(busy, { needsRequest, active: active && !cardOpen && !detailPanel, onOpenChange: onChatsOpenChange }) : sessions.length > 0 && (
                        <select
                            disabled={busy}
                            aria-label="Conversation history"
                            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm sm:max-w-56"
                            value={sessionId ?? ''}
                            onChange={event => onSelectSession(event.target.value || null)}
                        >
                            <option value="">New conversation</option>
                            {sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
                        </select>
                    )}
                </div>
                <h1 aria-label={agent.name} className="min-w-0">
                    <FloatingPill label="Coworker card" active={cardOpen} onClick={() => cardOpen ? overviewCloseControl.requestClose(dismissCard) : setCardOpen(true)} className="max-w-full pl-1.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                            <AgentBuddy agentId={agent.id} mood={inactive ? 'asleep' : generating ? 'working' : 'idle'} size={20} facing="right" />
                        </span>
                        <span className="truncate font-medium">{agent.name}</span>
                        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </FloatingPill>
                </h1>
                {onClosePanel && <Button type="button" aria-label={t('closePanel')} variant="ghost" size="icon-sm" className="justify-self-end" onClick={() => overviewCloseControl.requestClose(onClosePanel)}><XIcon className="size-4" /></Button>}
            </header>
            {cardOpen && !overviewCovered && <button type="button" aria-label="Back to the chat" className="absolute inset-0 z-30 bg-foreground/5 backdrop-blur-[2px]" onClick={() => overviewCloseControl.requestClose(dismissCard)} />}
            <section aria-label="Coworker details" hidden={!cardOpen} className={!cardOpen ? "hidden" : overview ? "absolute inset-x-3 top-14 bottom-3 z-40 flex min-h-0 flex-col overflow-auto rounded-2xl border border-border bg-background shadow-xl" : "absolute inset-x-3 top-14 z-40 rounded-2xl border border-border bg-background p-4 shadow-xl"}>
                {overview && cardOpen && active && <DesktopConversationOverview
                    authority={overview} agent={agent} active={active && !draft.quitting}
                    working={generating} settingsDisabledReason={generating || !!sessionId && engineRunning.id !== sessionId ? 'Wait for this coworker’s current run to finish.' : null}
                    closeControl={overviewCloseControl} onClose={dismissCard} onOpenSession={onSelectSession} onCoveredChange={setOverviewCovered}
                />}
                <div hidden={!!overview}>
                <p className="text-sm text-muted-foreground">{agent.description || 'Local coworker'}</p>
                {panelNotice && <p role="status" className="mt-2 text-sm text-muted-foreground">{panelNotice}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <DesktopCoworkerNotificationControl agentId={agent.id} name={agent.name} />
                    <DesktopCoworkerSetup agent={agent} dialogControl={dialogControl('setup')} />
                    <DesktopCoworkerFiles agent={agent} dialogControl={dialogControl('files')} initialFilePath={focusedFile}
                        onCloseAutoFocus={restoreWorkspaceFileFocus} />
                    <DesktopCoworkerData agent={agent} dialogControl={dialogControl('data')} />
                    <DesktopCoworkerRoutines agent={agent} dialogControl={dialogControl('scheduled')} onOpenChat={onSelectSession} />
                    <DesktopBoundTriggersPanel agent={agent} dialogControl={dialogControl('triggers')} onOpenChat={onSelectSession} />
                    <DesktopCoworkerSkills agent={agent} dialogControl={dialogControl('skills')} focusSlug={focusedSkill} />
                    <DesktopCoworkerTools agent={agent} dialogControl={dialogControl('tools')} />
                    <DesktopCoworkerMcpDialog agent={agent} dialogControl={dialogControl('mcp')} />
                    <Button type="button" variant="outline" size="sm" onClick={()=>setDetailPanel('services')}>Apps</Button>

                    <DesktopCoworkerMemories agent={agent} dialogControl={dialogControl('memories')} />
                    {renderRunHistory?.(dialogControl('logs'))}
                    <Button type="button" variant="ghost" size="sm" disabled={inactive} onClick={() => setScreenOpen('manual')}>Browser</Button>
                    <DesktopCoworkerMonitoring agent={agent} dialogControl={dialogControl('monitoring')} />
                    <DesktopCoworkerSettings agent={agent} authority={overview} disabled={generating || !!sessionId && engineRunning.id !== sessionId} dialogControl={dialogControl('settings')} />
                </div>
                </div>
            </section>
            <div inert={overviewCovered} className={cn('contents', overviewCovered && 'invisible')}>
            {tabStrip ?? <div className="flex shrink-0 items-center gap-1 px-3 pt-2 pb-1">
                <div aria-label="Current conversation" className="flex h-7 min-w-0 items-center gap-1 rounded-md bg-muted pl-2.5 pr-1 text-xs text-foreground">
                    <span title={currentTitle} className="max-w-40 truncate">{currentTitle}</span>
                    {sessionId && <Button type="button" variant="ghost" size="icon-xs" aria-label="Close current conversation" disabled={busy} onClick={() => onSelectSession(null)}><XIcon className="size-3" /></Button>}
                </div>
                <Button type="button" variant="ghost" size="icon-sm" title={t('newThread')} aria-label={t('newThread')} disabled={busy} onClick={() => onSelectSession(null, 'New conversation')}>
                    <PlusIcon aria-hidden className="size-3.5" /><span className="sr-only">New thread</span>
                </Button>
            </div>}

            <Conversation key={sessionId ?? 'new'} contextRef={conversationScroll} className="min-h-0" aria-label={t('chatMessages')}>
                <ConversationContent className="gap-4 px-3.5 py-4">
                    <DesktopConversationFind open={finding} onOpenChange={closeFind} transcript={findTranscript} />
                    {!ready && !historyError && !busy && <p role="status" className="text-sm text-muted-foreground">{t('openingSavedChat')}</p>}
                    {threadRows.leading.map(thread => <DesktopThreadBranch key={thread.id} thread={thread} needsYou={pendingChatSummaries?.has(thread.id)} onOpen={() => onSelectSession(thread.id, thread.title)} />)}
                    {ready && transcript.length === 0 && threadRows.leading.length === 0 && !busy && !setupBlocked && !historyError && (
                        <ConversationEmptyState className="px-2 py-10">
                            <AgentBuddy agentId={agent.id} mood={inactive ? 'asleep' : 'idle'} size={96} />
                            <div className="space-y-1">
                                <h3 className="text-sm font-medium">{t('chatStart.startTitle')}</h3>
                                {!inactive && <p className="text-sm text-muted-foreground">{t('chatStart.sendToCoworker')}</p>}
                            </div>
                            {canSendStarter && <Suggestions className="mt-2 justify-center">
                                {Object.values(language.messages.chatStart.starters).map(starter =>
                                    <Suggestion key={starter} suggestion={starter} onClick={sendStarter} />)}
                            </Suggestions>}
                        </ConversationEmptyState>
                    )}
                    {sessionId && active && <DesktopNativeWritebackReview agentId={agent.id} sessionId={sessionId} refreshKey={`${status}/${transcript.length}`}/>}
                    <div ref={findTranscript} className="contents">{transcript.map((message, messageIndex) => {
                        const branches = threadRows.after.get(messageIndex) ?? []
                        const createdAt = messageTimes[messageIndex]
                        const compaction = savedCompactionOf(message)
                        const withTimeline = (content: ReactNode) => <Fragment key={message.id}>
                            {timeBreaks.has(messageIndex) && <ChatTimeSeparator createdAt={createdAt} locale={locale} />}
                            <div className={branches.length === 0 ? 'contents' : undefined}>
                                <div className="contents" data-chat-find-message>{content}</div>
                                {compaction && <CompactionStep data={compaction} />}
                                {branches.map(thread =>
                                    <DesktopThreadBranch key={thread.id} thread={thread} needsYou={pendingChatSummaries?.has(thread.id)} onOpen={() => onSelectSession(thread.id, thread.title)} />
                                )}
                            </div>
                        </Fragment>
                        const scheduledRun = scheduledRunOf(message)
                        const triggerPayload = message.role === 'user' ? parseTriggerPayload(message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')) : null
                        const onOpenWorkspaceFile = active ? openWorkspaceFile : undefined
                        const install = message.role==='user' ? parseInstallMessage(message.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n')) : null
                        if(install)return withTimeline(<AgentInstallBlock agentId={agent.id} agentName={agent.name} onOpenWorkspaceFile={onOpenWorkspaceFile} guide={install.guide} installing={setup.view?.completedAt == null} />)
                        const receipt = savedReceipts.get(message.id)
                        if (receipt) return withTimeline(<DesktopSavedDecisionReceipt decision={receipt.decision} documents={receipt.documents}
                            onOpenDocument={active ? index => setDocumentPreview({ attachments: receipt.documents, index }) : undefined} />)
                        const hitl = message.role === 'user' ? parseHitlReply(message.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n')) : null
                        const secretReceipt = message.role === 'user' ? parseDesktopSecretReceiptSummary(message.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n')) : null
                        if (secretReceipt) return withTimeline(<DesktopSecretSummaryReceipt entries={secretReceipt} />)
                        if (hitl?.kind === 'mcp' || hitl?.kind === 'cancelled' && hitl.of === 'mcp') return withTimeline(<DesktopMcpSignInSummary name={hitl.kind === 'mcp' ? hitl.name : undefined} />)
                        if(hitl?.kind==='service')return withTimeline(<DesktopServiceRequestReceipt entries={hitl.entries} />)
                        if (triggerPayload) return withTimeline(<DesktopWebhookRunBlock agentId={agent.id} onOpenWorkspaceFile={onOpenWorkspaceFile} payload={triggerPayload} />)
                        if (scheduledRun) return withTimeline(<DesktopScheduledRunBlock agentId={agent.id} onOpenWorkspaceFile={onOpenWorkspaceFile} run={scheduledRun} />)
                        const voiceContext = { workspaceId, sessionId, tabUid, messageId: message.id,
                            active: active && ready && !cardOpen && !detailPanel && !chatsOpen && !draft.quitting }
                        const textParts = message.parts.filter(part => part.type === 'text')
                        const voicePart = message.role === 'user' && textParts.length === 1 ? textParts[0] : undefined
                        const renderBubble = (voicePlayer?: ReactNode) => {
                            const content = (
                                <MessageContent data-ink={voicePlayer ? true : undefined} className={cn(message.role === 'user' ? [USER_BUBBLE_SHAPE, USER_BUBBLE_INK, 'whitespace-pre-wrap wrap-anywhere'] : 'overflow-visible')}>
                                    {message.role === 'user' && (() => {
                                        const selections = messageAttachmentPaths(message.metadata)
                                        const paths = selections.filter((item): item is string => typeof item === 'string')
                                        const files = message.parts.filter((part): part is FileUIPart => part.type === 'file' && part.mediaType.startsWith('image/'))
                                        const images = files.length ? files.map((part, index) => ({ path: `${index}/${part.filename ?? 'image.png'}`, url: part.url }))
                                            : selections.filter((item): item is DesktopImageSnapshot => typeof item !== 'string').map((image, index) => ({ path: `${index}/${image.name}`, url: `/api/desktop/agents/${encodeURIComponent(agent.id)}/images?snapshot=${encodeURIComponent(JSON.stringify(image))}` }))
                                        const refs = message.metadata && typeof message.metadata === 'object' && 'documents' in message.metadata ? desktopDocumentReferenceSchema.array().safeParse(message.metadata.documents) : null
                                        const messageId = message.id.startsWith('engine-') ? message.id.slice('engine-'.length) : ''
                                        return <>{refs?.success && refs.data.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{refs.data.map((ref, index) => <Button type="button" variant="secondary" size="sm" key={ref.attachmentId} onClick={() => setDocumentPreview({ attachments: refs.data, index })}>{ref.name}</Button>)}</div>}{paths.length > 0 && <div className="mb-1"><AttachmentChips paths={paths} onPreview={sessionId && messageId
                                            ? index => setWorkspacePreview({ owner: uploadOwner, source: { sessionId, messageId }, paths, index })
                                            : undefined} /></div>}
                                            {images.length > 0 && <MessageAttachments paths={images.map(item => item.path)} rawUrlFor={path => images.find(item => item.path === path)?.url ?? ''} />}</>
                                    })()}
                                    {voicePlayer ?? (message.role === 'assistant'
                                        ? <DesktopAssistantReply agent={agent} message={message} agentId={agent.id} createdAt={createdAt} streaming={message === streamingMessage} latest={message === latestAssistant}
                                            onOpenWorkspaceFile={onOpenWorkspaceFile}
                                            toolInstall={sessionId ? { sessionId, active: active && ready, disabled: draft.quitting || inactive || generating || stopping } : undefined}
                                            childRuns={sessionId ? { sessionId, active, onOpenTarget: onOpenCoworkerChat } : undefined}
                                            skillProposals={{ rows: skillProposals.proposals, pinnedIds: skillProposals.pinnedIds, pendingId: skillProposals.pendingId,
                                                onDecide: proposalsActive ? skillProposals.decide : undefined, onOpenSkill: proposalsActive ? openProposalSkill : undefined }}
                                            pendingRequestToolCallId={pendingRequest?.toolCallId} answeredRequestCalls={answeredCalls.get(message.id)}
                                            quickReplies={{ show: messageIndex === transcript.length - 1 && quickRepliesVisible, disabled: !canSendQuickReply,
                                                pending: quickReplyBusy || queue.pending, onSend: text => sendQuickReply(message.id, text) }}
                                            feedbackRating={feedback.votes.get(message.id)?.rating ?? null}
                                            onRate={message.id.startsWith('engine-') ? rating => feedback.rate(message.id, rating) : undefined}
                                            onRegenerate={canRegenerate && message.id.startsWith('engine-') ? regenerateReply : undefined} />
                                        : message.parts.map((part, index) => {
                                            if (part.type !== 'text') return null
                                            const text = message.role === 'user'
                                                ? <DesktopWorkspaceMessage agentId={agent.id} onOpenWorkspaceFile={onOpenWorkspaceFile}
                                                    composer metadata={message.metadata}>{part.text}</DesktopWorkspaceMessage>
                                                : <DesktopSelectedMentionText text={part.text} metadata={message.metadata} linkify={false} />
                                            const body = message.role === 'user' && part.text ? <ExpandableMessageBody forceExpanded={finding}
                                                showMore={t('showMore')} showLess={t('showLess')}>{text}</ExpandableMessageBody> : text
                                            return message.role === 'user' && !voicePart
                                                ? <DesktopVoiceHistoryMessage key={index} agentId={agent.id} text={part.text} context={voiceContext}>{body}</DesktopVoiceHistoryMessage>
                                                : <Fragment key={index}>{body}</Fragment>
                                        }))}
                                </MessageContent>
                            )
                            return message.role === 'user'
                                ? <MessageTimeTooltip createdAt={createdAt} locale={locale} side="left">{content}</MessageTimeTooltip>
                                : content
                        }
                        const bubble = voicePart
                            ? <DesktopVoiceHistoryMessage agentId={agent.id} text={voicePart.text} context={voiceContext} renderPlayer={renderBubble}>{renderBubble()}</DesktopVoiceHistoryMessage>
                            : renderBubble()
                        return withTimeline(
                            <div className={cn('flex min-w-0 items-end', message.role === 'user' && 'justify-end gap-2')}>
                                <Message from={message.role} className="min-w-0">
                                    {bubble}
                                </Message>
                                {message.role === 'user' && <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"><UserRoundIcon className="size-4" /></span>}
                            </div>
                        )
                    })}</div>
                    {sessionId && <DesktopToolInstallPending agentId={agent.id} sessionId={sessionId} messages={transcript} active={active && ready} disabled={draft.quitting || inactive || generating || stopping} />}
                    {active && stopping
                        ? <DesktopChatActivity agentId={agent.id} stopping />
                        : generating && sessionId
                            ? <DesktopComputerPanel key={sessionId} agentId={agent.id} sessionId={sessionId} active={active} takeoverPending={!!takeover} fullViewerOpen={screenOpen !== null} onOpen={() => setScreenOpen('manual')} fallback={chatActivity} />
                            : chatActivity}
                    {stopError && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{stopError}</div>}
                    {(history.id === sessionId && history.runsUnavailable) && <p role="status" className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">This reply’s status is unavailable. Nothing was sent again.</p>}
                    {reconnecting && <p role="status" className="text-sm text-muted-foreground">Reconnecting to this reply…</p>}
                    {historyError && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                        {historyError}
                        <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => {
                            setHistory({ id: undefined })
                            setAttempt(n => n + 1)
                        }}>Retry conversation</Button>
                    </div>}
                    {!recovery.notice && stopBanner && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{stopBanner}</div>}
                    {recovery.notice && <DesktopProviderErrorNotice
                        kind={recovery.notice.kind}
                        message={recovery.notice.message}
                        onRetry={canRetry ? () => recovery.act('retry') : undefined}
                        onContinue={() => recovery.act('continue')}
                        onStopRun={() => recovery.act('stop')}
                        onNewConversation={() => recovery.act('new-conversation')}
                        onReconnect={() => recovery.act('reconnect')}
                        onSwitchModel={() => recovery.act('switch-model')}
                    />}
                    {requestCards.map(card => (
                        <div key={card.key} ref={waitingCard === card ? pendingBlock : undefined}
                            tabIndex={card.cue ? -1 : undefined} role={card.cue ? 'group' : undefined} aria-label={card.cue?.label}
                            className="min-w-0 focus-visible:outline-1 focus-visible:outline-ring">
                            {card.node}
                        </div>
                    ))}
                </ConversationContent>
                {transcriptActive && <ConversationScrollButton pending={pendingCue} aria-label={t('scrollToLatestMessage')} />}
            </Conversation>
            </div>

            {serviceApps?.destination === 'vault' && <DesktopVaultDialog
                onClose={() => serviceApps.settle()}
                suggestedApp={{ slug: serviceApps.slug, onUse: account => serviceApps.settle(undefined, account) }} />}
            <DesktopServicesDialog agent={agent} hideTrigger focusSlug={serviceApps?.slug} focusRequestKey={serviceApps?.token} dialogControl={{open:detailPanel==='services'||!!serviceApps&&serviceApps.destination!=='vault',onOpenChange:open=>{
                if(!open){serviceApps?.settle();if(detailPanel==='services')setDetailPanel(null)}else if(!serviceApps)setDetailPanel('services')
            }}} />
            <IsolatedScreenDialog open={active && screenOpen !== null} onOpenChange={open => { if (!open) setScreenOpen(null) }} agentId={agent.id} title={`${agent.name}’s browser`}
                takeover={screenOpen === 'request' && takeover ? { callId: takeover.toolCallId, url: takeover.url, reason: takeover.reason } : null}
                screenApi={screenOpen === 'request' ? screenApi : undefined}
                onHandBack={async callId => {
                    if (!takeover || takeover.toolCallId !== callId) throw new Error('This browser request changed.')
                    await decideTakeover(takeover.attempt ?? { action: 'done', takeoverId: takeover.id, requestId: crypto.randomUUID() })
                }} />
            <MessageFeedbackDialog open={feedback.dialogOpen} rating={feedback.dialogRating} notice="Feedback is stored on this Mac." onOpenChange={feedback.onDialogOpenChange} onSubmit={feedback.submitDetails} />
            <div inert={overviewCovered} className={cn('shrink-0 border-t p-2.5', pendingRequest && 'border-t-0 py-0', overviewCovered && 'invisible')}>
                {proposalsActive && <DesktopSkillProposalDock proposals={pinnedSkillProposals} pendingId={skillProposals.pendingId} onDecide={skillProposals.decide} onOpenSkill={openProposalSkill} />}
                {proposalsActive && skillProposals.unavailable && <p role="status" className="mb-2 text-xs text-muted-foreground">Could not check all proposed changes. <Button type="button" variant="link" size="sm" onClick={() => void skillProposals.refresh()}>Retry</Button></p>}
                {draft.quitting ? <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">Saving drafts before quitting…</p>
                    : draft.error ? <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs text-destructive">
                        <span>{draft.error}</span>
                        {draft.conflict ? <><Button type="button" size="sm" variant="outline" onClick={() => void draft.keep()}>Keep this draft</Button><Button type="button" size="sm" variant="outline" onClick={() => void draft.reload()}>Use saved draft</Button></>
                            : <Button type="button" size="sm" variant="outline" onClick={() => void draft.retry()}>Retry saving draft</Button>}
                    </div> : tabUid && (!draft.loaded || draft.saving || input || attachmentPaths.length) ? <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">{!draft.loaded ? 'Restoring draft…' : draft.saving ? 'Saving draft…' : 'Draft saved'}</p> : null}
                {inactive && <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">This coworker is inactive. Enable it from the board to send a message. Your chats are kept.</p>}
                {queueFeedback && <p role={queue.error ? 'alert' : 'status'} className="mb-2 px-1 text-xs text-muted-foreground">{queueCopy[queueFeedback]}</p>}
                {uploadNotice && <p role="alert" className="mb-2 px-1 text-xs text-destructive">{uploadNotice}</p>}
                {uploadsActive && <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">Preparing attachments…</p>}
                {blockedUploadNotice && <p role="alert" className="mb-2 px-1 text-xs text-destructive">{blockedUploadNotice}</p>}
                {queuedBehindFailure && !queueNotice && <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">{queueCopy.previousFailed}</p>}
                <QueuedMessagePill text={queued && !(draftQueues.current.has(queued.id) && input.trim() === queued.text && samePaths(attachmentPaths, desktopQueuedAttachmentPaths(queued))) ? desktopQueuedPreview(queued) : null}
                    copy={language.messages.queuedMessage}
                    busy={generating} pending={!draft.loaded || !!draft.error || draft.quitting || (requestBlocked && !generating) || !!pendingRequest || queue.pending || stopping || inactive || !!flushingQueue.current}
                    onSendNow={() => void sendQueuedNow()} onDiscard={() => { if (queued && !isDesktopQuitting()) void queue.action('remove', queued.id).then(() => { setQueueNotice(undefined); setSendQueuedId(null) }).catch(() => {}) }} />
                {setup.error && <div role="alert" className="p-2 text-sm text-destructive">{setup.error}<Button type="button" size="sm" variant="ghost" onClick={()=>void setup.refresh()}>Retry setup</Button></div>}
                {setupBlocked && <DesktopSetupGate agentId={agent.id} agentName={agent.name} apps={[]} canStart={modelReady} onStartBlocked={onOpenModelSettings} modelSlot={<Button type="button" variant="ghost" size="sm" onClick={onOpenModelSettings}>{modelLabel ?? 'Choose a model'}</Button>} disabled={inactive || generating || stopping || draft.quitting} onOpenSetupChat={target=>onSelectSession?.(target.sessionId)} />}
                {setup.view?.skipped && <DesktopSetupSkippedBanner agentId={agent.id} canStart={modelReady} onStartBlocked={onOpenModelSettings} disabled={inactive || generating || stopping || draft.quitting} onOpenSetupChat={target=>onSelectSession?.(target.sessionId)} />}
                {documentPreview && <DesktopDocumentLightbox {...documentPreview} onIndexChange={index => setDocumentPreview(value => value ? { ...value, index } : null)} onClose={() => setDocumentPreview(null)} />}
                {active && workspacePreview?.owner === uploadOwner && <DesktopWorkspaceAttachmentLightbox {...workspacePreview}
                    onIndexChange={index => setWorkspacePreview(value => value && { ...value, index })}
                    onClose={() => setWorkspacePreview(null)} />}
                <MarkdownEditorDialog key={editorSession} open={active && editorOpen} onOpenChange={setEditorOpen} initialValue={input} title={editorCopy.title} description={editorCopy.description} hint={editorCopy.hint} closeLabel={editorCopy.cancel} submitLabel={editorCopy.send} submitIcon={<SendIcon className="size-4" />} submitting={preparingSend || stopping}
                    onDraftChange={setInput}
                    onClose={markdown => { setInput(markdown); queueMicrotask(() => composerForm.current?.querySelector('textarea')?.focus()) }}
                    onSubmit={markdown => {
                        // The normal form admission compares the current draft with its render's
                        // snapshot. Publish edited text before dispatching that form's submit.
                        flushSync(() => { setInput(markdown); setEditorOpen(false) })
                        if (!active || inactive || stopping || draft.quitting || !ready || uploadsActive || preparingSend || !!pendingRequest) return
                        composerForm.current?.requestSubmit()
                    }} />
                <form ref={composerForm} data-slot="desktop-composer" onSubmit={submit} hidden={!!pendingRequest || setupBlocked} className={cn('relative min-w-0 flex-col rounded-xl border border-input bg-muted/40 focus-within:border-ring', pendingRequest || setupBlocked ? 'hidden' : 'flex')}>
                    {uploadDragOver && <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] border border-dashed border-brand bg-background/85">
                        <span className="flex items-center gap-2 text-sm font-medium text-brand"><UploadIcon className="size-4" />Drop files to attach</span>
                    </div>}
                    {(attachmentPaths.length > 0 || uploadItems.length > 0 || imageUploads.items.length > 0) && <div className="px-2.5 pt-2"><div className="flex flex-wrap items-center gap-1">
                        {attachmentPaths.map((item, index) => typeof item === 'string'
                            ? <AttachmentChips key={`${index}:${item}`} paths={[item]}
                                disabled={draft.quitting || !!regenerationSource || stopping || queue.pending || uploadsActive}
                                locked={pendingAttachment.current?.key === draftKey ? pendingAttachment.current.attachments.filter((path): path is string => typeof path === 'string') : undefined}
                                onPreview={() => setWorkspacePreview({ owner: uploadOwner, source: { agentId: agent.id }, paths: textAttachments, index: textAttachments.indexOf(item) })}
                                onRemove={path => setDraftAttachments(draftKey, attachmentPaths.filter(item => item !== path))} />
                            : <ChatAttachmentChip key={`${index}:${item.sha256}`}
                                file={{ id: item.sha256, type: 'file', mediaType: item.mediaType, filename: item.name,
                                    url: `/api/desktop/agents/${encodeURIComponent(agent.id)}/images?snapshot=${encodeURIComponent(JSON.stringify(item))}` }}
                                upload={undefined} disabled={draft.quitting || !!regenerationSource || stopping || queue.pending || uploadsActive || !!pendingAttachment.current}
                                onRemove={hash => setDraftAttachments(draftKey, attachmentPaths.filter(value => typeof value === 'string' || value.sha256 !== hash))}
                                onRetry={() => {}} />)}
                        <DesktopUploadChips items={uploadItems} disabled={uploadDisabled} onRemove={removeUpload} onRetry={retryUpload} />
                        <DesktopImageUploadChips items={imageUploads.items} disabled={uploadDisabled} onRemove={imageUploads.remove} onRetry={imageUploads.retry} />
                    </div></div>}
                    {!!tabUid && <DesktopDocumentAttachmentControls controller={documents} disabled={uploadDisabled || preparingSend} />}
                    <input ref={uploadFileInput} type="file" multiple className="hidden" aria-label="Upload files from this Mac"
                        onChange={event => {
                            const files = Array.from(event.target.files ?? [])
                            event.target.value = ''
                            beginUpload(files)
                        }} />
                    <label htmlFor={composerId} className="sr-only">Message {agent.name}</label>
                    <DesktopCoworkerMentions scope={draftKey} agentId={agent.id} text={input} mentions={coworkerMentions} onTextChange={setInput}
                        onMentionsChange={value => { pickedMentions.current = value }}
                        enabled={active && !inactive && draft.loaded && !draft.error && !draft.quitting && !regenerationSource && !detailPanel}
                        refreshKey={`${status}:${lastMessage?.id ?? ''}`}>
                    {mention => <>
                    <div className="relative">
                    {expandable && draft.loaded && !draft.error && <button type="button" aria-label={editorCopy.open} title={editorCopy.open} className="absolute top-1.5 right-1.5 z-10 rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" onClick={() => { setEditorSession(value => value + 1); setEditorOpen(true) }}><Maximize2Icon className="size-3.5" /></button>}
                    <Textarea
                        ref={mention.inputRef}
                        id={composerId}
                        rows={2}
                        className={cn('min-h-12 w-full resize-none rounded-none border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent',
                            expandable && 'pr-9', mention.linkMirror && 'text-transparent caret-foreground [scrollbar-gutter:stable]')}
                        maxLength={20_000}
                        disabled={inactive || !draft.loaded || !!draft.error || draft.quitting}
                        readOnly={!!regenerationSource || !!attachmentPaths.length && status === 'submitted'}
                        placeholder={placeholder}
                        {...mention.textareaProps}
                        onPaste={event => {
                            const files = Array.from(event.clipboardData.files)
                            if (!files.length) { mention.textareaProps.onPaste(event); return }
                            event.preventDefault()
                            beginUpload(files)
                        }}
                    />
                    {mention.linkMirror && <ComposerLinkMirror {...mention.linkMirror}
                        className={cn('px-2.5 py-2 text-base text-foreground md:text-sm [scrollbar-gutter:stable]', expandable && 'pr-9')}
                        labels={{ open: t('composerLink.open'), unlink: t('composerLink.unlink') }}
                        editable={!inactive && draft.loaded && !draft.error && !draft.quitting && !regenerationSource && !(attachmentPaths.length && status === 'submitted')} />}
                    </div>
                    {mention.menu}
                    {mention.targetError && /(?:^|\s)@\S*$/.test(input) && <div role="status" className="flex items-center gap-2 px-2.5 pb-2 text-xs text-muted-foreground"><span>{mention.targetError}</span><Button type="button" variant="ghost" size="xs" onClick={mention.retryTargets}>Retry coworkers</Button></div>}
                    {mention.error && /(?:^|\s)\/\S*$/.test(input) && <div role="status" className="flex items-center gap-2 px-2.5 pb-2 text-xs text-muted-foreground">
                        <span>{mention.error}</span><Button type="button" variant="ghost" size="xs" onClick={mention.retry}>Retry skills</Button>
                    </div>}
                    </>}
                    </DesktopCoworkerMentions>
                    <div ref={setVoiceReviewTarget} />
                    <div className="flex min-w-0 items-center justify-between gap-2 px-1.5 pb-1.5">
                        <DesktopModelSelector active={active} agentId={agent.id} sessionId={sessionId} disabled={generating || stopping}
                            connections={connections} workspaceDefault={workspaceDefault} onOpenSettings={onOpenModelSettings} onConversationChoice={rememberModel}
                            onReady={setModelReady} onBlocked={setModelBlock} openRequest={openModelRequest} />
                        <div className="flex shrink-0 items-center gap-1">
                            <DesktopAttachmentPicker key={draftKey} agent={agent} disabled={uploadDisabled || uploadsActive}
                                paths={textAttachments} onChange={paths => {
                                    if (uploadsBusy()) return
                                    const next = attachmentPaths.filter(item => typeof item !== 'string' || paths.includes(item))
                                    setDraftAttachments(draftKey, [...next, ...paths.filter(path => !textAttachments.includes(path))])
                                }} />
                            <Button type="button" size="icon-sm" variant="ghost" title="Upload files from this Mac" disabled={uploadDisabled}
                                onClick={() => uploadFileInput.current?.click()}>
                                <UploadIcon aria-hidden className="size-4" /><span className="sr-only">Upload files from this Mac</span>
                            </Button>
                            {tabUid && draft.loaded && <DesktopVoiceComposer agentId={agent.id} tabUid={tabUid} sessionId={sessionId ?? undefined}
                                reviewTarget={voiceReviewTarget} modelChoice={!sessionId && conversationChoice.current?.session === null ? conversationChoice.current.pick : undefined}
                                active={active && !draft.quitting && !cardOpen && !detailPanel && !chatsOpen} besideSend
                                disabled={generating || stopping || inactive || !ready || !modelReady || requestBlocked || !!pendingRequest || !!queue.queued || queue.pending || uploadsActive || preparingSend || !draft.loaded}
                                onActivity={setVoiceActivity} onSent={voiceSent} onOpenTranscriptionSettings={onOpenTranscriptionSettings} />}
                            {generating && <Button type="button" variant="ghost" size="icon-sm" disabled={stopping || !stopTarget || !stopRunId} onClick={() => void handleStop()}><SquareIcon aria-hidden className="size-4" /><span className="sr-only">{t('stop')}</span></Button>}
                            <Button type="submit" title={generating ? 'Queue message' : 'Send message'} size="icon-sm" className="rounded-full" disabled={voiceActivity.busy || !draft.loaded || !uploadsLoaded || !!draft.error || draft.quitting || (requestBlocked && !generating) || !!pendingRequest || inactive || (!input.trim() && !attachmentPaths.length && !documents.attachments.length) || stopping || !ready || !queue.loaded || queue.pending || !!queue.error || uploadsActive || blockedUploads.length > 0 || preparingSend}>
                                <ArrowUpIcon aria-hidden className="size-4" /><span className="sr-only">{t('send')}</span>
                            </Button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    )
}
