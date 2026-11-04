'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { Message, MessageContent } from '@rerun/ui/chat'
import { FloatingPill } from '@/components/agent/sheet/floating'
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation'
import { USER_BUBBLE_INK, USER_BUBBLE_SHAPE } from '@/components/chat/bubble-styles'
import { ArrowUpIcon, ChevronDownIcon, PlusIcon, SquareIcon, UserRoundIcon, XIcon } from '@/lib/icons'
import { MessageFeedbackDialog } from '@/components/chat/MessageFeedbackDialog'
import { useDesktopReplyFeedback } from '@/lib/desktop/reply-feedback'
import { DesktopAssistantReply } from './DesktopAssistantReply'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { lastUserText } from '@/lib/chat-payload'
import { cn } from '@/lib/utils'
import type { DesktopAgentView, DesktopSessionView } from './DesktopApp'
import { DesktopCoworkerSettings } from './DesktopCoworkerSettings'
import { DesktopCoworkerMemories } from './DesktopCoworkerMemories'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'
import { DesktopCoworkerData } from './DesktopCoworkerData'
import { DesktopCoworkerTools } from './DesktopCoworkerTools'
import { DesktopCoworkerMonitoring } from './DesktopCoworkerMonitoring'
import type { DesktopCoworkerPanel } from '@/lib/desktop/coworker-panel'
import type { DesktopCoworkerPanelRequest } from '@/lib/desktop/coworker-panel-request'
import { AttachmentChips, DesktopAttachmentPicker } from './DesktopAttachmentPicker'
import { pendingTabWrite } from '@/lib/desktop/tab-writes'
import { DesktopModelSelector } from './DesktopModelSelector'
import type { DesktopModelPick } from '@/lib/desktop/chat-model'
import { QueuedMessagePill } from '@/components/chat/QueuedMessagePill'
import { shouldFlush, shouldKeepQueued } from '@/lib/chat/queued-message'
import { desktopQueuedAttachmentPaths, desktopQueuedPreview, type DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { useDesktopQueuedMessage } from '@/lib/desktop/use-queued-message'
import { HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions, desktopAttachmentFieldsOf, desktopAttachmentPathsOf, type DesktopAttachmentFields } from '@rerun/contracts'
import { desktopQuestionViewSchema, type DesktopPendingQuestion, type DesktopQuestionAnswer } from '@/lib/desktop/questions'
import { DesktopQuestionCard } from './DesktopQuestionCard'
import { desktopApprovalViewSchema, type DesktopPendingApproval, type DesktopApprovalAnswer } from '@/lib/desktop/approvals'
import { DesktopApprovalCard } from './DesktopApprovalCard'
import { desktopQuickRepliesOf } from '@/lib/desktop/quick-replies'
import { useDesktopComposerDraft } from '@/lib/desktop/use-composer-draft'
import { holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'

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

async function historyFor(sessionId: string, signal: AbortSignal): Promise<UIMessage[]> {
    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/messages`, { signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load conversation history')
    if (!Array.isArray(body.messages)) throw new Error('Could not load conversation history')
    return body.messages as UIMessage[]
}

const stopUrl = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/stop`
const RUN_POLL_MS = 3000

export type ComposerDraft = { text: string; attachment?: string; attachments?: string[] }
export type TabActivity = { busy: boolean; dirty: boolean; readableSessionId?: string | null }

const draftPaths = (draft: ComposerDraft | undefined) => draft ? (draft.attachments?.length ? draft.attachments : draft.attachment ? [draft.attachment] : []) : []
const samePaths = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((path, index) => path === b[index])
const messageAttachmentPaths = (metadata: unknown): string[] =>
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? desktopAttachmentPathsOf(metadata as DesktopAttachmentFields) : []

export function DesktopConversation({ agent, sessionId, sessions, tabUid, active = true, requestedPanel, onPanelRequestHandled, tabStrip, initialDraft, onTabActivity, onStartFork, onFinishFork, onSelectSession, onChatSession, renderHistory, renderRunHistory, onClosePanel, modelLabel, onOpenModelSettings }: {
    agent: DesktopAgentView
    sessionId: string | null
    sessions: DesktopSessionView[]
    onSelectSession: (id: string | null) => void
    onStartFork?: (uid: string) => boolean
    onFinishFork?: (uid: string) => void
    tabUid?: string
    active?: boolean
    requestedPanel?: DesktopCoworkerPanelRequest | null
    onPanelRequestHandled?: (request: DesktopCoworkerPanelRequest) => void
    tabStrip?: ReactNode
    initialDraft?: ComposerDraft
    onTabActivity?: (uid: string, state: TabActivity) => void
    onChatSession: (id: string, sourceDraft?: ComposerDraft) => void | boolean | Promise<boolean>
    renderHistory?: (busy: boolean) => ReactNode
    renderRunHistory?: ReactNode
    onClosePanel?: () => void
    modelLabel?: string
    onOpenModelSettings?: () => void
}) {
    const [cardOpen, setCardOpen] = useState(false)
    const [detailPanel, setDetailPanel] = useState<Exclude<DesktopCoworkerPanel, 'chat'> | null>(null)
    const [panelNotice, setPanelNotice] = useState('')
    const handledPanel = useRef<DesktopCoworkerPanelRequest | null>(null)
    const conversationRoot = useRef<HTMLDivElement>(null)
    const [panelFocus, setPanelFocus] = useState<'chat' | 'card' | null>(null)
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
            setDetailPanel(open ? panel : null)
        },
    })
    const draftKey = JSON.stringify([agent.id, sessionId])
    const initialPaths = draftPaths(initialDraft)
    const [inputs, setInputs] = useState<ReadonlyMap<string, string>>(() => new Map(initialDraft ? [[draftKey, initialDraft.text]] : []))
    const [attachments, setAttachments] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map(initialPaths.length ? [[draftKey, initialPaths]] : []))
    // Ordinary navigation carries the current composer. An alternate and its original keep independent drafts.
    const inputKey = inputs.has(draftKey) ? draftKey : ''
    const composer = useRef<ComposerDraft>({ text: initialDraft?.text ?? '', attachments: initialPaths })
    const draft = useDesktopComposerDraft(agent.id, tabUid, value => {
        const paths = desktopAttachmentPathsOf(value)
        setInputs(current => new Map(current).set(draftKey, value.text))
        setAttachments(current => {
            const next = new Map(current)
            if (paths.length) next.set(draftKey, paths)
            else next.delete(draftKey)
            return next
        })
        composer.current = { text: value.text, attachments: paths }
    })
    // The tab UID remains stable when the first accepted message receives its session ID.
    // Production reads the durable record directly, so newer typing cannot fall off that bind.
    const input = tabUid ? draft.text : inputs.get(inputKey) ?? ''
    const attachmentPaths = tabUid ? desktopAttachmentPathsOf(draft) : attachments.get(draftKey) ?? []
    const attachmentSignature = attachmentPaths.join('\u0000')
    const setInput = (value: string) => {
        if (!draft.loaded || draft.error || regenerating.current || isDesktopQuitting()) return
        setInputs(current => new Map(current).set(inputKey, value))
        composer.current = { text: value, attachments: [...attachmentPaths] }
        draft.update({ text: value, ...desktopAttachmentFieldsOf(attachmentPaths) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the path signature covers inline arrays
    useEffect(() => { composer.current = { text: input, attachments: [...attachmentPaths] } }, [input, attachmentSignature])
    const pendingAttachment = useRef<{ key: string; inputKey: string; input: string; attachments: readonly string[]; version: number; release: () => void } | null>(null)
    const preparingSubmit = useRef(false)
    const regenerationIds = useRef(new Map<string, string>())
    const regenerating = useRef<{ key: string; agentId: string; sessionId: string; draftKey: string; release: () => void } | null>(null)
    const [regenerationSource, setRegenerationSource] = useState<string | null>(null)
    const setDraftAttachments = useCallback((key: string, paths: readonly string[]) => {
        if (!draft.loaded || (draft.error && !draft.attachmentRejected) || regenerating.current || isDesktopQuitting()) return
        setAttachments(current => {
            const next = new Map(current)
            if (paths.length) next.set(key, [...paths])
            else next.delete(key)
            return next
        })
        if (key === draftKey) {
            composer.current = { ...composer.current, attachments: [...paths] }
            draft.update({ text: composer.current.text, ...desktopAttachmentFieldsOf(paths) })
        }
    }, [draft.loaded, draft.error, draft.attachmentRejected, draft.update, draftKey])
    const [history, setHistory] = useState<{ id: string | null | undefined; transcript?: UIMessage[]; question?: DesktopPendingQuestion | null; approval?: DesktopPendingApproval | null; error?: string; loadedGeneration?: number }>({ id: null, question: null, approval: null })
    const responding = useRef<{ sessionId: string; payload: DesktopQuestionAnswer | DesktopApprovalAnswer; url: string; receiptHeader: string; receiptId: string; accepted: boolean; error?: Error } | null>(null)
    const quickReplyRequest = useRef<{ sessionId: string; requestId: string; accepted: boolean } | null>(null)
    const quickReplyIds = useRef(new Map<string, string>())
    const quickReplyContext = useRef<{ scope: string; messageId?: string; canSend: boolean }>({ scope: draftKey, canSend: false })
    const [quickReplyBusy, setQuickReplyBusy] = useState(false)
    const [quickReplyRetry, setQuickReplyRetry] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    // An engine run still generating for this conversation (e.g. after reopening it mid-reply).
    const [engineRunning, setEngineRunning] = useState<{ id: string | null; running: boolean; runId?: string | null; failedRunId?: string | null }>({ id: null, running: false })
    const [stopping, setStopping] = useState(false)
    const [stopError, setStopError] = useState<string>()
    const [liveSessionId, setLiveSessionId] = useState<string | null>(null)
    const [liveRunId, setLiveRunId] = useState<string | null>(null)
    const queue = useDesktopQueuedMessage(agent.id, sessionId, tabUid)
    const queueScope = useRef(queue.key)
    useEffect(() => { queueScope.current = queue.key; return () => { queueScope.current = '' } }, [queue.key])
    const [queueNotice, setQueueNotice] = useState<string>()
    const [modelReady, setModelReady] = useState(false)
    const [sendQueuedId, setSendQueuedId] = useState<string | null>(null)
    const flushingQueue = useRef<string | null>(null)
    const restoredQueues = useRef(new Set<string>())
    const draftQueues = useRef(new Set<string>())
    const pendingQueue = useRef<{ item: DesktopQueuedMessage; sessionId: string; acknowledge: () => Promise<unknown> } | null>(null)
    const conversationChoice = useRef<{ session: string | null; pick?: DesktopModelPick } | null>(null)
    const rememberModel = useCallback((pick: DesktopModelPick | undefined) => { conversationChoice.current = { session: sessionId, pick } }, [sessionId])

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
        if (queued && (id !== queued.sessionId || response.headers.get('x-run-id') !== queued.item.id)) throw new Error('Could not confirm this queued message. It is still saved; try Send now to check again.')
        if (response.ok && id) {
            if (queued) {
                try { await queued.acknowledge() } catch { setQueueNotice('The message was sent, but its queue receipt could not be cleared. Send now will check the same message safely.') }
                if (flushingQueue.current === queued.item.id) flushingQueue.current = null
            }
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
    }, [agent.id, tabUid, onChatSession, draft.clear, draft.reload, draft.invalidate])

    // The constructor saves the callback; only a submitted request reads the pending draft.
    // eslint-disable-next-line react-hooks/refs
    const transport = useMemo(() => new DefaultChatTransport({
        api: '/api/desktop/chat',
        prepareSendMessagesRequest: ({ body, messages, trigger, messageId }) => ({
            body: trigger === 'regenerate-message' ? { ...body, regenerateMessageId: messageId } : { ...body, text: lastUserText(messages) },
        }),
        fetch: sendToEngine,
    }), [sendToEngine])

    const { messages, setMessages, sendMessage, regenerate, stop, status, error, clearError } = useChat({
        id: tabUid ? `desktop-${agent.id}-${tabUid}` : `desktop-${agent.id}`,
        transport,
        experimental_throttle: 60,
    })

    const busy = status === 'submitted' || status === 'streaming'
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
        if (!requestedPanel || !active || requestedPanel.agentId !== agent.id || handledPanel.current === requestedPanel) return
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
        setCardOpen(true)
        if (requestedPanel.panel === 'settings' && generating) {
            setPanelNotice('Wait for this reply to finish before editing the coworker.')
            setPanelFocus('card')
            return
        }
        setPanelFocus(null)
        setDetailPanel(requestedPanel.panel)
    }, [requestedPanel, active, agent.id, sessionId, busy, engineRunning.id, generating, onPanelRequestHandled])
    useEffect(() => {
        if (!panelFocus || !active || detailPanel) return
        const selector = panelFocus === 'chat' ? 'textarea' : '[aria-label="Coworker card"]'
        conversationRoot.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
        setPanelFocus(null)
    }, [panelFocus, active, detailPanel, cardOpen])
    const dirty = !draft.loaded || !!(input || attachmentPaths.length || queue.queued)
    const readable = active && !cardOpen && !detailPanel && ready && !generating && history.loadedGeneration === historyGeneration
        && !!history.transcript && history.question !== undefined && history.approval !== undefined
        && engineRunning.id === sessionId
    useEffect(() => { if (tabUid) onTabActivity?.(tabUid, { busy: generating, dirty, readableSessionId: readable ? sessionId : null }) }, [tabUid, generating, dirty, readable, sessionId, onTabActivity])
    const question = history.id === sessionId ? history.question : undefined
    const approval = history.id === sessionId ? history.approval : undefined
    const pendingRequest = question || approval
    // Both request kinds must be known before a later turn or an automatic queue flush.
    const requestBlocked = !!sessionId && (question !== null || approval !== null)
    const canRegenerate = draft.loaded && !draft.error && !draft.quitting && !quickReplyBusy && !requestBlocked && !inactive && !!sessionId && ready && !!history.transcript && engineRunning.id === sessionId && !generating && !stopping && !queue.queued && !queue.pending
    const feedback = useDesktopReplyFeedback(agent.id, sessionId, active)
    const stopTarget = busy ? liveSessionId : runInFlight ? sessionId : null
    const historyError = history.id === sessionId ? history.error : undefined
    // The SDK throttles message updates. Show the verified snapshot immediately when switching,
    // even if its subscription still holds the previous chat's messages.
    const showSaved = ready && (!busy || regenerationSource === sessionId && !!sessionId)
    const transcript = showSaved ? history.transcript ?? messages : busy ? messages : []

    useEffect(() => {
        if (busy) return
        const controller = new AbortController()
        const read = sessionId ? Promise.all([historyFor(sessionId, controller.signal), questionFor(sessionId, controller.signal), approvalFor(sessionId, controller.signal)]) : Promise.resolve([[], null, null] as [UIMessage[], null, null])
        void read.then(([result, pending, approval]) => {
            if (controller.signal.aborted) return
            if (pending && approval) throw new Error('This conversation changed while loading. Reload it to see the current request.')
            setMessages(result)
            setHistory({ id: sessionId, transcript: result, question: pending, approval, loadedGeneration: historyGeneration })
        }).catch(cause => {
            if (!controller.signal.aborted) setHistory({ id: sessionId, error: cause instanceof Error ? cause.message : 'Could not load history' })
        })
        return () => controller.abort()
    }, [sessionId, setMessages, busy, attempt, historyGeneration])

    useEffect(() => {
        setStopError(undefined)
        if (busy || !sessionId || !ready) return
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let wasRunning = false
        const check = async () => {
            try {
                const response = await fetch(stopUrl(sessionId))
                const body = await response.json().catch(() => ({}))
                if (cancelled) return
                if (!response.ok) throw new Error('Run status unavailable')
                const running = body.running === true
                setEngineRunning({ id: sessionId, running, runId: running && typeof body.runId === 'string' ? body.runId : null, failedRunId: typeof body.failedRunId === 'string' ? body.failedRunId : null })
                if (running) {
                    wasRunning = true
                    timer = setTimeout(check, RUN_POLL_MS)
                } else if (wasRunning) {
                    setHistory(current => current.id === sessionId ? { ...current, question: undefined, approval: undefined } : current)
                    setAttempt(n => n + 1) // The reply finished elsewhere: reload the saved transcript.
                }
            } catch {
                if (!cancelled) timer = setTimeout(check, RUN_POLL_MS)
            }
        }
        void check()
        return () => { cancelled = true; clearTimeout(timer) }
    }, [sessionId, busy, ready, attempt])

    async function handleStop(): Promise<boolean> {
        const id = stopTarget
        if (!id || stopping) return false
        setStopError(undefined)
        // Abort the renderer stream, then cancel the actual engine run (as upstream AgentChat.handleStop).
        setStopping(true)
        if (busy) {
            setEngineRunning({ id, running: true })
            stop()
        }
        try {
            const response = await fetch(stopUrl(id), { method: 'POST' })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not stop this reply. Try again.')
            setEngineRunning({ id, running: false })
            setHistory(current => current.id === id ? { ...current, question: undefined, approval: undefined } : current)
            setAttempt(n => n + 1)
            return true
        } catch (cause) {
            setStopError(cause instanceof Error ? cause.message : 'Could not stop this reply. Try again.')
            return false
        } finally {
            setStopping(false)
        }
    }

    async function submit(event: React.FormEvent) {
        event.preventDefault()
        const text = input.trim()
        if (!draft.loaded || draft.error || isDesktopQuitting() || preparingSubmit.current || (requestBlocked && !generating) || !!pendingRequest || (responding.current && !(generating && responding.current.accepted)) || (quickReplyRequest.current && !(generating && quickReplyRequest.current.accepted)) || inactive || !text || stopping || !ready || !queue.loaded || queue.pending || queue.error || regenerating.current || pendingAttachment.current) return
        preparingSubmit.current = true
        const release = holdDraftAdmission()
        const version = draft.version
        let handedOff = false
        try {
            if (!await draft.flush() || isDesktopQuitting()) return
            if (generating || (queue.queued && draftQueues.current.has(queue.queued.id))) {
                const queuedPaths = queue.queued ? desktopQueuedAttachmentPaths(queue.queued) : []
                const sameDraft = !generating && queue.queued && queue.queued.text === text && samePaths(queuedPaths, attachmentPaths)
                const item = sameDraft ? queue.queued : await queue.enqueue(text, attachmentPaths, busy ? liveRunId : engineRunning.runId ?? null)
                if (!item) return
                if (draft.clear(version)) {
                    setInputs(current => current.get(inputKey) === input ? new Map(current).set(inputKey, '') : current)
                    setAttachments(current => { const next = new Map(current); if (samePaths(current.get(draftKey) ?? [], attachmentPaths)) next.delete(draftKey); return next })
                }
                draftQueues.current.delete(item.id)
                setQueueNotice(undefined)
                if (!generating) setSendQueuedId(item.id)
                return
            }
            setLiveSessionId(null)
            setLiveRunId(null)
            const pending = { key: draftKey, inputKey, input, attachments: [...attachmentPaths], version, release }
            pendingAttachment.current = pending
            const pick = !sessionId && conversationChoice.current?.session === null ? conversationChoice.current.pick : undefined
            const attachmentFields = desktopAttachmentFieldsOf(attachmentPaths)
            const body = { agentId: agent.id, sessionId: sessionId ?? undefined, ...(!sessionId && tabUid && { tabUid }), ...(pick && { modelChoice: pick }), ...attachmentFields }
            handedOff = true
            void sendMessage({ text, ...(attachmentPaths.length && { metadata: attachmentFields }) }, { body }).finally(() => {
                if (pendingAttachment.current === pending) pendingAttachment.current = null
                release()
            })
        } catch { /* Draft/queue saves retain the composer and expose their own retry controls. */ }
        finally { preparingSubmit.current = false; if (!handedOff) release() }
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
            await sendMessage({ text: item.text, ...(paths.length && { metadata: attachmentFields }) }, {
                body: { agentId: agent.id, sessionId, text: item.text, requestId: item.id, ...attachmentFields },
            })
        } catch (cause) {
            setQueueNotice(cause instanceof Error ? cause.message : 'Could not send the queued message. It is still saved.')
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
        // Cancellation must finish before the flush effect starts another stream. The engine's
        // Stop operation cancels all current runs in this conversation, including a reopened one.
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
            await queue.action('review', item.id)
            if (!isCurrent()) return
            if (composer.current.text.trim() === item.text && samePaths(draftPaths(composer.current), paths)) draftQueues.current.add(item.id)
            // An older waiting message must not replace a newer draft already in the composer.
            if (!composer.current.text && draftPaths(composer.current).length === 0) {
                draftQueues.current.add(item.id)
                setInputs(current => new Map(current).set(draftKey, item.text))
                setAttachments(current => { const next = new Map(current); if (paths.length) next.set(draftKey, paths); else next.delete(draftKey); return next })
                composer.current = { text: item.text, attachments: paths }
                draft.update({ text: item.text, ...desktopAttachmentFieldsOf(paths) })
            }
            setQueueNotice('Your saved queued message is ready to review before sending.')
        }
        void (async () => {
            if (item.state === 'sending' && sessionId) {
                // A restart may have lost only the HTTP acknowledgement. Reconcile the exact
                // request before offering its draft again; this probe can never create a run.
                const response = await fetch('/api/desktop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                    agentId: agent.id, sessionId, text: item.text, requestId: item.id, reconcileOnly: true,
                    ...desktopAttachmentFieldsOf(desktopQueuedAttachmentPaths(item)),
                }) })
                if (response.ok && response.headers.get('x-session-id') === sessionId && response.headers.get('x-run-id') === item.id) {
                    await response.body?.cancel()
                    await queue.action('remove', item.id)
                    if (isCurrent()) setAttempt(n => n + 1)
                    return
                }
                if (response.status !== 404) throw new Error('Could not check the saved queued message. Use Send now to retry safely.')
            }
            await restoreDraft()
        })().catch(cause => { if (isCurrent()) setQueueNotice(cause instanceof Error ? cause.message : 'Could not restore the queued message.') })
    }, [active, activeRunId, agent.id, draftKey, queue, queueStatusKnown, ready, sessionId, stopping, draft.loaded, draft.error, draft.quitting, draft.update])

    const queued = queue.queued
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

    const composerId = !active && tabUid ? `desktop-message-${tabUid}` : 'desktop-message'
    const currentTitle = sessions.find(session => session.id === sessionId)?.title ?? 'New conversation'
    return (
        <div ref={conversationRoot} className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col bg-background" onKeyDown={event => {
            if (cardOpen && event.key === 'Escape' && !event.defaultPrevented && !(event.target as HTMLElement).closest('[role="dialog"]')) {
                event.preventDefault()
                event.stopPropagation()
                dismissCard()
                setPanelFocus('card')
            }
        }}>
            <header className="relative z-40 grid shrink-0 grid-cols-[minmax(2.5rem,1fr)_minmax(0,max-content)_minmax(2.5rem,1fr)] items-center gap-1 px-3 pt-3">
                <div className="flex min-w-0 items-center justify-start">
                    {renderHistory ? renderHistory(busy) : sessions.length > 0 && (
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
                    <FloatingPill label="Coworker card" active={cardOpen} onClick={() => cardOpen ? dismissCard() : setCardOpen(true)} className="max-w-full pl-1.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                            <AgentBuddy agentId={agent.id} mood={inactive ? 'asleep' : generating ? 'working' : 'idle'} size={20} facing="right" />
                        </span>
                        <span className="truncate font-medium">{agent.name}</span>
                        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </FloatingPill>
                </h1>
                {onClosePanel && <Button type="button" aria-label="Close panel" variant="ghost" size="icon-sm" className="justify-self-end" onClick={onClosePanel}><XIcon className="size-4" /></Button>}
            </header>
            {cardOpen && <button type="button" aria-label="Back to the chat" className="absolute inset-0 z-30 bg-foreground/5 backdrop-blur-[2px]" onClick={dismissCard} />}
            <section aria-label="Coworker details" hidden={!cardOpen} className="absolute inset-x-3 top-14 z-40 rounded-2xl border border-border bg-background p-4 shadow-xl">
                <p className="text-sm text-muted-foreground">{agent.description || 'Local coworker'}</p>
                {panelNotice && <p role="status" className="mt-2 text-sm text-muted-foreground">{panelNotice}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <DesktopCoworkerFiles agent={agent} dialogControl={dialogControl('files')} />
                    <DesktopCoworkerData agent={agent} dialogControl={dialogControl('data')} />
                    <DesktopCoworkerTools agent={agent} dialogControl={dialogControl('tools')} />
                    <DesktopCoworkerMemories agent={agent} dialogControl={dialogControl('memories')} />
                    {renderRunHistory}
                    <DesktopCoworkerMonitoring agent={agent} dialogControl={dialogControl('monitoring')} />
                    <DesktopCoworkerSettings agent={agent} disabled={generating || !!sessionId && engineRunning.id !== sessionId} dialogControl={dialogControl('settings')} />
                </div>
            </section>
            {tabStrip ?? <div className="flex shrink-0 items-center gap-1 px-3 pt-2 pb-1">
                <div aria-label="Current conversation" className="flex h-7 min-w-0 items-center gap-1 rounded-md bg-muted pl-2.5 pr-1 text-xs text-foreground">
                    <span title={currentTitle} className="max-w-40 truncate">{currentTitle}</span>
                    {sessionId && <Button type="button" variant="ghost" size="icon-xs" aria-label="Close current conversation" disabled={busy} onClick={() => onSelectSession(null)}><XIcon className="size-3" /></Button>}
                </div>
                <Button type="button" variant="ghost" size="icon-sm" title="New chat" disabled={busy} onClick={() => onSelectSession(null)}>
                    <PlusIcon aria-hidden className="size-3.5" /><span className="sr-only">New chat</span>
                </Button>
            </div>}

            <Conversation key={sessionId ?? 'new'} className="min-h-0" aria-label="Chat messages">
                <ConversationContent className="gap-4 px-3.5 py-4">
                    {!ready && !historyError && !busy && <p role="status" className="text-sm text-muted-foreground">Loading conversation…</p>}
                    {ready && transcript.length === 0 && !busy && (
                        <div className="py-16 text-center">
                            <div className="text-sm font-medium">Start a conversation with {agent.name}</div>
                            <div className="mt-1 text-sm text-muted-foreground">Messages stream from the local engine and remain available after restart.</div>
                        </div>
                    )}
                    {transcript.map((message, messageIndex) => (
                        <div key={message.id} className={cn('flex min-w-0 items-end', message.role === 'user' && 'justify-end gap-2')}>
                            <Message from={message.role} className="min-w-0">
                                <MessageContent className={cn(message.role === 'user' ? [USER_BUBBLE_SHAPE, USER_BUBBLE_INK, 'whitespace-pre-wrap wrap-anywhere'] : 'overflow-visible')}>
                                    {message.role === 'user' && (() => {
                                        const paths = messageAttachmentPaths(message.metadata)
                                        return paths.length ? <div className="mb-1"><AttachmentChips paths={paths} /></div> : null
                                    })()}
                                    {message.role === 'assistant'
                                        ? <DesktopAssistantReply message={message} agentId={agent.id} streaming={status === 'streaming' && messageIndex === transcript.length - 1}
                                            pendingRequestToolCallId={pendingRequest?.toolCallId}
                                            quickReplies={{ show: messageIndex === transcript.length - 1 && quickRepliesVisible, disabled: !canSendQuickReply,
                                                pending: quickReplyBusy || queue.pending, onSend: text => sendQuickReply(message.id, text) }}
                                            feedbackRating={feedback.votes.get(message.id)?.rating ?? null}
                                            onRate={message.id.startsWith('engine-') ? rating => feedback.rate(message.id, rating) : undefined}
                                            onRegenerate={canRegenerate && message.id.startsWith('engine-') ? regenerateReply : undefined} />
                                        : message.parts.map((part, index) => part.type === 'text' ? <span key={index}>{part.text}</span> : null)}
                                </MessageContent>
                            </Message>
                            {message.role === 'user' && <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"><UserRoundIcon className="size-4" /></span>}
                        </div>
                    ))}
                    {generating && <div className="text-sm text-muted-foreground">{agent.name} is working…</div>}
                    {stopError && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{stopError}</div>}
                    {(error || historyError) && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                        {historyError || error?.message}
                        {historyError && <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => {
                            setHistory({ id: undefined })
                            setAttempt(n => n + 1)
                        }}>Retry conversation</Button>}
                    </div>}
                </ConversationContent>
            </Conversation>

            <MessageFeedbackDialog open={feedback.dialogOpen} rating={feedback.dialogRating} notice="Feedback is stored on this Mac." onOpenChange={feedback.onDialogOpenChange} onSubmit={feedback.submitDetails} />
            <div className="shrink-0 border-t p-2.5">
                {draft.quitting ? <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">Saving drafts before quitting…</p>
                    : draft.error ? <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs text-destructive">
                        <span>{draft.error}</span>
                        {draft.conflict ? <><Button type="button" size="sm" variant="outline" onClick={() => void draft.keep()}>Keep this draft</Button><Button type="button" size="sm" variant="outline" onClick={() => void draft.reload()}>Use saved draft</Button></>
                            : <Button type="button" size="sm" variant="outline" onClick={() => void draft.retry()}>Retry saving draft</Button>}
                    </div> : tabUid && (!draft.loaded || draft.saving || input || attachmentPaths.length) ? <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">{!draft.loaded ? 'Restoring draft…' : draft.saving ? 'Saving draft…' : 'Draft saved'}</p> : null}
                {inactive && <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">This coworker is inactive. Enable it from the board to send a message. Your chats are kept.</p>}
                {(queue.error || queueNotice) && <p role={queue.error ? 'alert' : 'status'} className="mb-2 px-1 text-xs text-muted-foreground">{queue.error || queueNotice}</p>}
                {queuedBehindFailure && !queueNotice && <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">The previous reply failed. Your queued message is kept; use Send now when you are ready.</p>}
                <QueuedMessagePill text={queued && !(draftQueues.current.has(queued.id) && input.trim() === queued.text && samePaths(attachmentPaths, desktopQueuedAttachmentPaths(queued))) ? desktopQueuedPreview(queued) : null}
                    busy={generating} pending={!draft.loaded || !!draft.error || draft.quitting || (requestBlocked && !generating) || !!pendingRequest || queue.pending || stopping || inactive || !!flushingQueue.current}
                    onSendNow={() => void sendQueuedNow()} onDiscard={() => { if (queued && !isDesktopQuitting()) void queue.action('remove', queued.id).then(() => { setQueueNotice(undefined); setSendQueuedId(null) }).catch(() => {}) }} />
                {question && <DesktopQuestionCard key={question.id} question={question} disabled={draft.quitting || !active || inactive || generating || stopping || !ready} onAnswer={answerQuestion} />}
                {approval && <DesktopApprovalCard key={approval.id} approval={approval} disabled={draft.quitting || !active || inactive || generating || stopping || !ready} onDecide={decideApproval} />}
                <form onSubmit={submit} hidden={!!pendingRequest} className={cn('min-w-0 flex-col rounded-xl border border-input bg-muted/40 focus-within:border-ring', pendingRequest ? 'hidden' : 'flex')}>
                    {attachmentPaths.length > 0 && <div className="px-2.5 pt-2"><AttachmentChips paths={attachmentPaths}
                        disabled={draft.quitting || !!regenerationSource || stopping || queue.pending}
                        locked={pendingAttachment.current?.key === draftKey ? pendingAttachment.current.attachments : undefined}
                        onRemove={path => setDraftAttachments(draftKey, attachmentPaths.filter(item => item !== path))} /></div>}
                    <label htmlFor={composerId} className="sr-only">Message {agent.name}</label>
                    <Textarea
                        id={composerId}
                        rows={2}
                        className="min-h-12 w-full resize-none rounded-none border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
                        maxLength={20_000}
                        disabled={inactive || !draft.loaded || !!draft.error || draft.quitting}
                        readOnly={!!regenerationSource || !!attachmentPaths.length && status === 'submitted'}
                        placeholder="Send a message…"
                        value={input}
                        onChange={event => setInput(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault()
                                event.currentTarget.form?.requestSubmit()
                            }
                        }}
                    />
                    <div className="flex min-w-0 items-center justify-between gap-2 px-1.5 pb-1.5">
                        <DesktopModelSelector active={active} agentId={agent.id} sessionId={sessionId} disabled={generating || stopping}
                            workspaceModel={modelLabel} onOpenSettings={onOpenModelSettings} onConversationChoice={rememberModel} onReady={setModelReady} />
                        <div className="flex shrink-0 items-center gap-1">
                            <DesktopAttachmentPicker key={draftKey} agent={agent} disabled={inactive || stopping || !ready || queue.pending || !draft.loaded || (!!draft.error && !draft.attachmentRejected) || !!regenerationSource || draft.quitting}
                                paths={attachmentPaths} onChange={paths => setDraftAttachments(draftKey, paths)} />
                            {generating && <Button type="button" variant="ghost" size="icon-sm" disabled={stopping || !stopTarget} onClick={() => void handleStop()}><SquareIcon aria-hidden className="size-4" /><span className="sr-only">Stop</span></Button>}
                            <Button type="submit" title={generating ? 'Queue message' : 'Send message'} size="icon-sm" className="rounded-full" disabled={!draft.loaded || !!draft.error || draft.quitting || (requestBlocked && !generating) || !!pendingRequest || inactive || !input.trim() || stopping || !ready || !queue.loaded || queue.pending || !!queue.error}>
                                <ArrowUpIcon aria-hidden className="size-4" /><span className="sr-only">Send</span>
                            </Button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    )
}
