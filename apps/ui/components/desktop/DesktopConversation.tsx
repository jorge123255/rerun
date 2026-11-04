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
import { DesktopCoworkerTools } from './DesktopCoworkerTools'
import { DesktopCoworkerMonitoring } from './DesktopCoworkerMonitoring'
import { AttachmentChip, DesktopAttachmentPicker } from './DesktopAttachmentPicker'
import { pendingTabWrite } from '@/lib/desktop/tab-writes'
import { DesktopModelSelector } from './DesktopModelSelector'
import type { DesktopModelPick } from '@/lib/desktop/chat-model'
import { QueuedMessagePill } from '@/components/chat/QueuedMessagePill'
import { shouldFlush, shouldKeepQueued } from '@/lib/chat/queued-message'
import { desktopQueuedPreview, type DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { useDesktopQueuedMessage } from '@/lib/desktop/use-queued-message'
import { HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions } from '@rerun/contracts'
import { desktopQuestionViewSchema, type DesktopPendingQuestion, type DesktopQuestionAnswer } from '@/lib/desktop/questions'
import { DesktopQuestionCard } from './DesktopQuestionCard'
import { desktopApprovalViewSchema, type DesktopPendingApproval, type DesktopApprovalAnswer } from '@/lib/desktop/approvals'
import { DesktopApprovalCard } from './DesktopApprovalCard'

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

export type ComposerDraft = { text: string; attachment?: string }
export type TabActivity = { busy: boolean; dirty: boolean }

export function DesktopConversation({ agent, sessionId, sessions, tabUid, active = true, tabStrip, initialDraft, onTabActivity, onStartFork, onFinishFork, onSelectSession, onChatSession, renderHistory, renderRunHistory, onClosePanel, modelLabel, onOpenModelSettings }: {
    agent: DesktopAgentView
    sessionId: string | null
    sessions: DesktopSessionView[]
    onSelectSession: (id: string | null) => void
    onStartFork?: (uid: string) => boolean
    onFinishFork?: (uid: string) => void
    tabUid?: string
    active?: boolean
    tabStrip?: ReactNode
    initialDraft?: ComposerDraft
    onTabActivity?: (uid: string, state: TabActivity) => void
    onChatSession: (id: string, sourceDraft?: ComposerDraft) => void
    renderHistory?: (busy: boolean) => ReactNode
    renderRunHistory?: ReactNode
    onClosePanel?: () => void
    modelLabel?: string
    onOpenModelSettings?: () => void
}) {
    const [cardOpen, setCardOpen] = useState(false)
    const draftKey = JSON.stringify([agent.id, sessionId])
    const [inputs, setInputs] = useState<ReadonlyMap<string, string>>(() => new Map(initialDraft ? [[draftKey, initialDraft.text]] : []))
    const [attachments, setAttachments] = useState<ReadonlyMap<string, string>>(() => new Map(initialDraft?.attachment ? [[draftKey, initialDraft.attachment]] : []))
    // Ordinary navigation carries the current composer. An alternate and its original keep independent drafts.
    const inputKey = inputs.has(draftKey) ? draftKey : ''
    const input = inputs.get(inputKey) ?? ''
    const setInput = (value: string) => setInputs(current => new Map(current).set(inputKey, value))
    const attachment = attachments.get(draftKey)
    const composer = useRef<ComposerDraft>({ text: input, attachment })
    useEffect(() => { composer.current = { text: input, attachment } }, [input, attachment])
    const pendingAttachment = useRef<{ key: string; inputKey: string; input: string; attachment?: string } | null>(null)
    const regenerationIds = useRef(new Map<string, string>())
    const regenerating = useRef<{ key: string; agentId: string; sessionId: string; draftKey: string } | null>(null)
    const [regenerationSource, setRegenerationSource] = useState<string | null>(null)
    const setDraftAttachment = useCallback((key: string, path?: string) => {
        setAttachments(current => {
            const next = new Map(current)
            if (path) next.set(key, path)
            else next.delete(key)
            return next
        })
    }, [])
    const [history, setHistory] = useState<{ id: string | null | undefined; transcript?: UIMessage[]; question?: DesktopPendingQuestion | null; approval?: DesktopPendingApproval | null; error?: string }>({ id: null, question: null, approval: null })
    const responding = useRef<{ sessionId: string; payload: DesktopQuestionAnswer | DesktopApprovalAnswer; url: string; receiptHeader: string; receiptId: string; accepted: boolean; error?: Error } | null>(null)
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
        let response: Response
        try {
            if (tabUid) await pendingTabWrite(agent.id)
            response = await fetch(answer ? answer.url : url, answer ? { ...init, body: JSON.stringify(answer.payload) } : init)
            if ((pending || alternate || queued || answer) && !response.ok) {
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
            if (pending) {
                setInputs(current => current.get(pending.inputKey) === pending.input ? new Map(current).set(pending.inputKey, '') : current)
                setAttachments(current => {
                    if (current.get(pending.key) !== pending.attachment) return current
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
            onChatSession(id, alternate ? composer.current : undefined)
        }
        return response
    }, [agent.id, tabUid, onChatSession, setDraftAttachment])

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

    const ready = history.id === sessionId && !history.error
    const runInFlight = !busy && engineRunning.id === sessionId && engineRunning.running
    const generating = busy || runInFlight
    const dirty = !!(input || attachment || queue.queued)
    useEffect(() => { if (tabUid) onTabActivity?.(tabUid, { busy: generating, dirty }) }, [tabUid, generating, dirty, onTabActivity])
    const question = history.id === sessionId ? history.question : undefined
    const approval = history.id === sessionId ? history.approval : undefined
    const pendingRequest = question || approval
    // Both request kinds must be known before a later turn or an automatic queue flush.
    const requestBlocked = !!sessionId && (question !== null || approval !== null)
    const canRegenerate = !requestBlocked && !inactive && !!sessionId && ready && !!history.transcript && engineRunning.id === sessionId && !generating && !stopping && !queue.queued && !queue.pending
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
            setHistory({ id: sessionId, transcript: result, question: pending, approval })
        }).catch(cause => {
            if (!controller.signal.aborted) setHistory({ id: sessionId, error: cause instanceof Error ? cause.message : 'Could not load history' })
        })
        return () => controller.abort()
    }, [sessionId, setMessages, busy, attempt])

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
        if ((requestBlocked && !generating) || !!pendingRequest || (responding.current && !(generating && responding.current.accepted)) || inactive || !text || stopping || !ready || !queue.loaded || queue.pending || queue.error || regenerating.current) return
        if (generating || (queue.queued && draftQueues.current.has(queue.queued.id))) {
            if (!queue.loaded || queue.error) return
            try {
                const sameDraft = !generating && queue.queued && queue.queued.text === text && queue.queued.attachmentPath === attachment
                const item = sameDraft ? queue.queued : await queue.enqueue(text, attachment, busy ? liveRunId : engineRunning.runId ?? null)
                if (!item) return
                setInputs(current => current.get(inputKey) === input ? new Map(current).set(inputKey, '') : current)
                setDraftAttachment(draftKey)
                draftQueues.current.delete(item.id)
                setQueueNotice(undefined)
                if (!generating) setSendQueuedId(item.id)
            } catch { /* The hook keeps the composer and surfaces the failed write. */ }
            return
        }
        if (pendingAttachment.current) return
        // Wait for this send's engine-backed session ID before enabling Stop.
        setLiveSessionId(null)
        setLiveRunId(null)
        // Keep the draft until acceptance: a newer question may have arrived since our snapshot.
        pendingAttachment.current = { key: draftKey, inputKey, input, attachment }
        const pick = !sessionId && conversationChoice.current?.session === null ? conversationChoice.current.pick : undefined
        const body = { agentId: agent.id, sessionId: sessionId ?? undefined, ...(!sessionId && tabUid && { tabUid }), ...(pick && { modelChoice: pick }), ...(attachment && { attachmentPath: attachment }) }
        void sendMessage({ text, ...(attachment && { metadata: { attachmentPath: attachment } }) }, { body })
    }

    async function sendQueued(item: DesktopQueuedMessage) {
        if (requestBlocked || responding.current || !sessionId || inactive || stopping || generating || !ready || pendingAttachment.current || regenerating.current || flushingQueue.current) return
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
            await sendMessage({ text: item.text, ...(item.attachmentPath && { metadata: { attachmentPath: item.attachmentPath } }) }, {
                body: { agentId: agent.id, sessionId, text: item.text, requestId: item.id, ...(item.attachmentPath && { attachmentPath: item.attachmentPath }) },
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
        const item = queue.queued
        if ((requestBlocked && !generating) || !!pendingRequest || (responding.current && !(generating && responding.current.accepted)) || !item || inactive || queue.pending || stopping || flushingQueue.current) return
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
        if (!active || !item || !queue.loaded || queue.pending || !ready || stopping || !queueStatusKnown || (item.id !== queue.restoredId && item.state !== 'review') || flushingQueue.current) return
        if (item.state === 'waiting' && shouldKeepQueued(item, activeRunId)) { queue.adopt(item.id); return }
        const key = queue.key + item.id
        if (restoredQueues.current.has(key)) return
        restoredQueues.current.add(key)
        const isCurrent = () => queueScope.current === queue.key
        const restoreDraft = async () => {
            await queue.action('review', item.id)
            if (!isCurrent()) return
            if (composer.current.text.trim() === item.text && composer.current.attachment === item.attachmentPath) draftQueues.current.add(item.id)
            // An older waiting message must not replace a newer draft already in the composer.
            if (!composer.current.text && !composer.current.attachment) {
                draftQueues.current.add(item.id)
                setInputs(current => new Map(current).set(draftKey, item.text))
                setDraftAttachment(draftKey, item.attachmentPath)
            }
            setQueueNotice('Your saved queued message is ready to review before sending.')
        }
        void (async () => {
            if (item.state === 'sending' && sessionId) {
                // A restart may have lost only the HTTP acknowledgement. Reconcile the exact
                // request before offering its draft again; this probe can never create a run.
                const response = await fetch('/api/desktop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                    agentId: agent.id, sessionId, text: item.text, requestId: item.id, reconcileOnly: true,
                    ...(item.attachmentPath && { attachmentPath: item.attachmentPath }),
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
    }, [active, activeRunId, agent.id, draftKey, queue, queueStatusKnown, ready, sessionId, setDraftAttachment, stopping])

    const queued = queue.queued
    const queuedBehindFailure = !!queued?.behindRunId && queued.behindRunId === engineRunning.failedRunId
    const canFlushQueue = !requestBlocked && !inactive && !!sessionId && ready && modelReady && queue.loaded && !queue.pending && !queue.restoredId && queueStatusKnown && !stopping && !stopError && !queue.error
        && shouldFlush({ queued, busy: generating, uploading: !!pendingAttachment.current || !!regenerating.current, status, hasError: !!error || !!queueNotice || queuedBehindFailure })
    useEffect(() => {
        if (requestBlocked || !queued || queue.pending || !ready || !modelReady || !queueStatusKnown || inactive || generating || stopping || flushingQueue.current) return
        if (sendQueuedId === queued.id || (canFlushQueue && queued.state === 'waiting')) void sendQueued(queued)
    })

    async function regenerateReply(messageId: string) {
        if (!canRegenerate || !sessionId || !history.transcript || regenerating.current || pendingAttachment.current) return
        if (tabUid && onStartFork && !onStartFork(tabUid)) return
        const key = JSON.stringify([sessionId, messageId])
        const requestId = regenerationIds.current.get(key) ?? crypto.randomUUID()
        regenerationIds.current.set(key, requestId)
        regenerating.current = { key, agentId: agent.id, sessionId, draftKey }
        setRegenerationSource(sessionId)
        setLiveSessionId(null)
        try {
            setMessages(history.transcript)
            await regenerate({ messageId, body: { agentId: agent.id, sessionId, requestId } })
        } finally {
            if (tabUid) onFinishFork?.(tabUid)
            regenerating.current = null
            setRegenerationSource(null)
            setAttempt(n => n + 1)
        }
    }

    async function answerQuestion(payload: DesktopQuestionAnswer) {
        if (!active || !sessionId || !question || payload.questionId !== question.id || inactive || generating || stopping || !ready || responding.current || flushingQueue.current || regenerating.current) throw new Error('This question is not ready for an answer. Try again.')
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
        if (!active || !sessionId || !approval || payload.approvalId !== approval.id || inactive || generating || stopping || !ready || responding.current || flushingQueue.current || regenerating.current || pendingAttachment.current) throw new Error('This approval request is not ready. Try again.')
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

    const composerId = !active && tabUid ? `desktop-message-${tabUid}` : 'desktop-message'
    const currentTitle = sessions.find(session => session.id === sessionId)?.title ?? 'New conversation'
    return (
        <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col bg-background" onKeyDown={event => {
            if (cardOpen && event.key === 'Escape' && !event.defaultPrevented && !(event.target as HTMLElement).closest('[role="dialog"]')) {
                event.preventDefault()
                event.stopPropagation()
                setCardOpen(false)
                event.currentTarget.querySelector<HTMLButtonElement>('[aria-label="Coworker card"]')?.focus()
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
                    <FloatingPill label="Coworker card" active={cardOpen} onClick={() => setCardOpen(open => !open)} className="max-w-full pl-1.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                            <AgentBuddy agentId={agent.id} mood={inactive ? 'asleep' : generating ? 'working' : 'idle'} size={20} facing="right" />
                        </span>
                        <span className="truncate font-medium">{agent.name}</span>
                        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </FloatingPill>
                </h1>
                {onClosePanel && <Button type="button" aria-label="Close panel" variant="ghost" size="icon-sm" className="justify-self-end" onClick={onClosePanel}><XIcon className="size-4" /></Button>}
            </header>
            {cardOpen && <button type="button" aria-label="Back to the chat" className="absolute inset-0 z-30 bg-foreground/5 backdrop-blur-[2px]" onClick={() => setCardOpen(false)} />}
            <section aria-label="Coworker details" hidden={!cardOpen} className="absolute inset-x-3 top-14 z-40 rounded-2xl border border-border bg-background p-4 shadow-xl">
                <p className="text-sm text-muted-foreground">{agent.description || 'Local coworker'}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <DesktopCoworkerFiles agent={agent} />
                    <DesktopCoworkerTools agent={agent} />
                    <DesktopCoworkerMemories agent={agent} />
                    {renderRunHistory}
                    <DesktopCoworkerMonitoring agent={agent} />
                    <DesktopCoworkerSettings agent={agent} disabled={busy} />
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
                                    {message.role === 'user' && message.metadata && typeof message.metadata === 'object' && 'attachmentPath' in message.metadata && typeof message.metadata.attachmentPath === 'string' ?
                                        <div className="mb-1"><AttachmentChip path={message.metadata.attachmentPath} /></div> : null}
                                    {message.role === 'assistant'
                                        ? <DesktopAssistantReply message={message} streaming={status === 'streaming' && messageIndex === transcript.length - 1}
                                            pendingRequestToolCallId={pendingRequest?.toolCallId}
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
                {inactive && <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">This coworker is inactive. Enable it from the board to send a message. Your chats are kept.</p>}
                {(queue.error || queueNotice) && <p role={queue.error ? 'alert' : 'status'} className="mb-2 px-1 text-xs text-muted-foreground">{queue.error || queueNotice}</p>}
                {queuedBehindFailure && !queueNotice && <p role="status" className="mb-2 px-1 text-xs text-muted-foreground">The previous reply failed. Your queued message is kept; use Send now when you are ready.</p>}
                <QueuedMessagePill text={queued && !(draftQueues.current.has(queued.id) && input.trim() === queued.text && attachment === queued.attachmentPath) ? desktopQueuedPreview(queued) : null}
                    busy={generating} pending={(requestBlocked && !generating) || !!pendingRequest || queue.pending || stopping || inactive || !!flushingQueue.current}
                    onSendNow={() => void sendQueuedNow()} onDiscard={() => { if (queued) void queue.action('remove', queued.id).then(() => { setQueueNotice(undefined); setSendQueuedId(null) }).catch(() => {}) }} />
                {question && <DesktopQuestionCard key={question.id} question={question} disabled={!active || inactive || generating || stopping || !ready} onAnswer={answerQuestion} />}
                {approval && <DesktopApprovalCard key={approval.id} approval={approval} disabled={!active || inactive || generating || stopping || !ready} onDecide={decideApproval} />}
                <form onSubmit={submit} hidden={!!pendingRequest} className={cn('min-w-0 flex-col rounded-xl border border-input bg-muted/40 focus-within:border-ring', pendingRequest ? 'hidden' : 'flex')}>
                    {attachment && <div className="px-2.5 pt-2"><AttachmentChip path={attachment}
                        disabled={stopping || queue.pending || (pendingAttachment.current?.key === draftKey && pendingAttachment.current.attachment === attachment)}
                        onRemove={() => setDraftAttachment(draftKey)} /></div>}
                    <label htmlFor={composerId} className="sr-only">Message {agent.name}</label>
                    <Textarea
                        id={composerId}
                        rows={2}
                        className="min-h-12 w-full resize-none rounded-none border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
                        maxLength={20_000}
                        disabled={inactive}
                        readOnly={!!attachment && status === 'submitted'}
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
                            <DesktopAttachmentPicker key={draftKey} agent={agent} disabled={inactive || stopping || !ready || queue.pending}
                                onSelect={path => setDraftAttachment(draftKey, path)} />
                            {generating && <Button type="button" variant="ghost" size="icon-sm" disabled={stopping || !stopTarget} onClick={() => void handleStop()}><SquareIcon aria-hidden className="size-4" /><span className="sr-only">Stop</span></Button>}
                            <Button type="submit" title={generating ? 'Queue message' : 'Send message'} size="icon-sm" className="rounded-full" disabled={(requestBlocked && !generating) || !!pendingRequest || inactive || !input.trim() || stopping || !ready || !queue.loaded || queue.pending || !!queue.error}>
                                <ArrowUpIcon aria-hidden className="size-4" /><span className="sr-only">Send</span>
                            </Button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    )
}
