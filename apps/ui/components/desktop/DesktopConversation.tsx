'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { DesktopAssistantReply } from './DesktopAssistantReply'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { lastUserText } from '@/lib/chat-payload'
import { cn } from '@/lib/utils'
import type { DesktopAgentView, DesktopSessionView } from './DesktopApp'
import { DesktopCoworkerSettings } from './DesktopCoworkerSettings'
import { DesktopCoworkerMemories } from './DesktopCoworkerMemories'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'
import { AttachmentChip, DesktopAttachmentPicker } from './DesktopAttachmentPicker'

async function historyFor(sessionId: string, signal: AbortSignal): Promise<UIMessage[]> {
    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/messages`, { signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load conversation history')
    if (!Array.isArray(body.messages)) throw new Error('Could not load conversation history')
    return body.messages as UIMessage[]
}

const stopUrl = (sessionId: string) => `/api/desktop/sessions/${encodeURIComponent(sessionId)}/stop`
const RUN_POLL_MS = 3000

export function DesktopConversation({ agent, sessionId, sessions, onSelectSession, onChatSession, renderHistory }: {
    agent: DesktopAgentView
    sessionId: string | null
    sessions: DesktopSessionView[]
    onSelectSession: (id: string | null) => void
    onChatSession: (id: string) => void
    renderHistory?: (busy: boolean) => ReactNode
}) {
    const [inputs, setInputs] = useState<ReadonlyMap<string, string>>(() => new Map())
    const [attachments, setAttachments] = useState<ReadonlyMap<string, string>>(() => new Map())
    const draftKey = JSON.stringify([agent.id, sessionId])
    // Ordinary navigation carries the current composer. An alternate and its original keep independent drafts.
    const inputKey = inputs.has(draftKey) ? draftKey : ''
    const input = inputs.get(inputKey) ?? ''
    const setInput = (value: string) => setInputs(current => new Map(current).set(inputKey, value))
    const attachment = attachments.get(draftKey)
    const pendingAttachment = useRef<{ key: string; inputKey: string; input: string } | null>(null)
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
    const [history, setHistory] = useState<{ id: string | null | undefined; transcript?: UIMessage[]; error?: string }>({ id: null })
    const [attempt, setAttempt] = useState(0)
    // An engine run still generating for this conversation (e.g. after reopening it mid-reply).
    const [engineRunning, setEngineRunning] = useState<{ id: string | null; running: boolean }>({ id: null, running: false })
    const [stopping, setStopping] = useState(false)
    const [stopError, setStopError] = useState<string>()
    const [liveSessionId, setLiveSessionId] = useState<string | null>(null)

    const sendToEngine = useCallback<typeof fetch>(async (url, init) => {
        const pending = pendingAttachment.current
        const alternate = regenerating.current
        let response: Response
        try {
            response = await fetch(url, init)
            if ((pending || alternate) && !response.ok) {
                const body = await response.json().catch(() => null)
                const fallback = alternate ? 'Could not regenerate this reply. Try again.' : 'Could not send the message with this file. Try again.'
                throw new Error(typeof body?.error === 'string' ? body.error : fallback)
            }
        } finally {
            pendingAttachment.current = null
        }
        const id = response.headers.get('x-session-id')
        if (alternate && (!id || id === alternate.sessionId)) throw new Error('Could not open the alternate chat. Try again.')
        if (response.ok && id) {
            if (pending) {
                setInputs(current => current.get(pending.inputKey) === pending.input ? new Map(current).set(pending.inputKey, '') : current)
                setDraftAttachment(pending.key)
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
            setHistory({ id })
            onChatSession(id)
        }
        return response
    }, [onChatSession, setDraftAttachment])

    // The constructor saves the callback; only a submitted request reads the pending draft.
    // eslint-disable-next-line react-hooks/refs
    const transport = useMemo(() => new DefaultChatTransport({
        api: '/api/desktop/chat',
        prepareSendMessagesRequest: ({ body, messages, trigger, messageId }) => ({
            body: trigger === 'regenerate-message' ? { ...body, regenerateMessageId: messageId } : { ...body, text: lastUserText(messages) },
        }),
        fetch: sendToEngine,
    }), [sendToEngine])

    const { messages, setMessages, sendMessage, regenerate, stop, status, error } = useChat({
        id: `desktop-${agent.id}`,
        transport,
        experimental_throttle: 60,
    })

    const busy = status === 'submitted' || status === 'streaming'

    const ready = history.id === sessionId && !history.error
    const runInFlight = !busy && engineRunning.id === sessionId && engineRunning.running
    const generating = busy || runInFlight
    const canRegenerate = !!sessionId && ready && !!history.transcript && engineRunning.id === sessionId && !generating && !stopping
    const stopTarget = busy ? liveSessionId : runInFlight ? sessionId : null
    const historyError = history.id === sessionId ? history.error : undefined
    // The SDK throttles message updates. Show the verified snapshot immediately when switching,
    // even if its subscription still holds the previous chat's messages.
    const showSaved = ready && (!busy || regenerationSource === sessionId && !!sessionId)
    const transcript = showSaved ? history.transcript ?? messages : busy ? messages : []

    useEffect(() => {
        if (busy) return
        const controller = new AbortController()
        const read = sessionId ? historyFor(sessionId, controller.signal) : Promise.resolve([])
        void read.then(result => {
            if (controller.signal.aborted) return
            setMessages(result)
            setHistory({ id: sessionId, transcript: result })
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
                setEngineRunning({ id: sessionId, running })
                if (running) {
                    wasRunning = true
                    timer = setTimeout(check, RUN_POLL_MS)
                } else if (wasRunning) {
                    setAttempt(n => n + 1) // The reply finished elsewhere: reload the saved transcript.
                }
            } catch {
                if (!cancelled) timer = setTimeout(check, RUN_POLL_MS)
            }
        }
        void check()
        return () => { cancelled = true; clearTimeout(timer) }
    }, [sessionId, busy, ready, attempt])

    async function handleStop() {
        const id = stopTarget
        if (!id || stopping) return
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
            setAttempt(n => n + 1)
        } catch (cause) {
            setStopError(cause instanceof Error ? cause.message : 'Could not stop this reply. Try again.')
        } finally {
            setStopping(false)
        }
    }

    function submit(event: React.FormEvent) {
        event.preventDefault()
        const text = input.trim()
        if (!text || generating || stopping || !ready || pendingAttachment.current || regenerating.current) return
        // Wait for this send's engine-backed session ID before enabling Stop.
        setLiveSessionId(null)
        // A file can change or disappear after selection. Keep both drafts until the server accepts it.
        if (attachment) pendingAttachment.current = { key: draftKey, inputKey, input }
        else setInput('')
        const body = { agentId: agent.id, sessionId: sessionId ?? undefined, ...(attachment && { attachmentPath: attachment }) }
        void sendMessage({ text, ...(attachment && { metadata: { attachmentPath: attachment } }) }, { body })
    }

    async function regenerateReply(messageId: string) {
        if (!canRegenerate || !sessionId || !history.transcript || regenerating.current || pendingAttachment.current) return
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
            regenerating.current = null
            setRegenerationSource(null)
            setAttempt(n => n + 1)
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3 sm:px-5">
                <div className="min-w-0">
                    <h1 className="truncate text-base font-semibold">{agent.name}</h1>
                    <p className="truncate text-xs text-muted-foreground">{agent.description || 'Local coworker'}</p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
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
                    <DesktopCoworkerFiles agent={agent} />
                    <DesktopCoworkerMemories agent={agent} />
                    <DesktopCoworkerSettings agent={agent} disabled={busy} />
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onSelectSession(null)}>New chat</Button>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-6">
                <div className="mx-auto max-w-3xl space-y-4">
                    {!ready && !historyError && !busy && <p role="status" className="text-sm text-muted-foreground">Loading conversation…</p>}
                    {ready && transcript.length === 0 && !busy && (
                        <div className="py-16 text-center">
                            <div className="text-sm font-medium">Start a conversation with {agent.name}</div>
                            <div className="mt-1 text-sm text-muted-foreground">Messages stream from the local engine and remain available after restart.</div>
                        </div>
                    )}
                    {transcript.map((message, messageIndex) => (
                        <div key={message.id} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                            <div className={cn('min-w-0 max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6', message.role === 'user' ? 'whitespace-pre-wrap bg-primary text-primary-foreground' : 'bg-muted')}>
                                {message.role === 'user' && message.metadata && typeof message.metadata === 'object' && 'attachmentPath' in message.metadata && typeof message.metadata.attachmentPath === 'string' ?
                                    <div className="mb-1"><AttachmentChip path={message.metadata.attachmentPath} /></div> : null}
                                {message.role === 'assistant'
                                    ? <DesktopAssistantReply message={message} streaming={status === 'streaming' && messageIndex === transcript.length - 1}
                                        onRegenerate={canRegenerate && message.id.startsWith('engine-') ? regenerateReply : undefined} />
                                    : message.parts.map((part, index) => part.type === 'text' ? <span key={index}>{part.text}</span> : null)}
                            </div>
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
                </div>
            </div>

            <div className="border-t p-4">
                <form onSubmit={submit} className="mx-auto flex max-w-3xl flex-wrap items-end gap-2">
                    <div className="flex w-full flex-wrap items-center gap-2">
                        <DesktopAttachmentPicker key={draftKey} agent={agent} disabled={generating || stopping || !ready}
                            onSelect={path => setDraftAttachment(draftKey, path)} />
                        {attachment && <AttachmentChip path={attachment} disabled={generating || stopping} onRemove={() => setDraftAttachment(draftKey)} />}
                    </div>
                    <label htmlFor="desktop-message" className="sr-only">Message {agent.name}</label>
                    <Textarea
                        id="desktop-message"
                        rows={2}
                        className="min-w-0 flex-1"
                        maxLength={20_000}
                        readOnly={!!attachment && status === 'submitted'}
                        placeholder={`Message ${agent.name}…`}
                        value={input}
                        onChange={event => setInput(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault()
                                event.currentTarget.form?.requestSubmit()
                            }
                        }}
                    />
                    {generating && <Button type="button" variant="outline" disabled={stopping || !stopTarget} onClick={() => void handleStop()}>Stop</Button>}
                    <Button type="submit" disabled={!input.trim() || generating || stopping || !ready}>Send</Button>
                </form>
            </div>
        </div>
    )
}
