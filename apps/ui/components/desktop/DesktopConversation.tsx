'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { ReasoningStep } from '@/components/chat/ReasoningBlock'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { lastUserText } from '@/lib/chat-payload'
import { isDesktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { cn } from '@/lib/utils'
import type { DesktopAgentView, DesktopSessionView } from './DesktopApp'
import { DesktopCoworkerSettings } from './DesktopCoworkerSettings'
import { DesktopCoworkerMemories } from './DesktopCoworkerMemories'

async function historyFor(sessionId: string, signal: AbortSignal): Promise<UIMessage[]> {
    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/messages`, { signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load conversation history')
    if (!Array.isArray(body.messages)) throw new Error('Could not load conversation history')
    return body.messages as UIMessage[]
}

export function DesktopConversation({ agent, sessionId, sessions, onSelectSession, onChatSession, renderHistory }: {
    agent: DesktopAgentView
    sessionId: string | null
    sessions: DesktopSessionView[]
    onSelectSession: (id: string | null) => void
    onChatSession: (id: string) => void
    renderHistory?: (busy: boolean) => ReactNode
}) {
    const [input, setInput] = useState('')
    const [history, setHistory] = useState<{ id: string | null | undefined; transcript?: UIMessage[]; error?: string }>({ id: null })
    const [attempt, setAttempt] = useState(0)

    const transport = useMemo(() => new DefaultChatTransport({
        api: '/api/desktop/chat',
        prepareSendMessagesRequest: ({ body, messages }) => ({ body: { ...body, text: lastUserText(messages) } }),
        fetch: async (url, init) => {
            const response = await fetch(url, init)
            const id = response.headers.get('x-session-id')
            if (response.ok && id) {
                // A new session gets its ID from the first response. Keep its live stream visible.
                setHistory({ id })
                onChatSession(id)
            }
            return response
        },
    }), [onChatSession])

    const { messages, setMessages, sendMessage, status, error } = useChat({
        id: `desktop-${agent.id}`,
        transport,
        experimental_throttle: 60,
    })

    const busy = status === 'submitted' || status === 'streaming'

    const ready = history.id === sessionId && !history.error
    const historyError = history.id === sessionId ? history.error : undefined
    // The SDK throttles message updates. Show the verified snapshot immediately when switching,
    // even if its subscription still holds the previous chat's messages.
    const transcript = busy ? messages : ready ? history.transcript ?? messages : []

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

    function submit(event: React.FormEvent) {
        event.preventDefault()
        const text = input.trim()
        if (!text || busy || !ready) return
        setInput('')
        void sendMessage({ text }, { body: { agentId: agent.id, sessionId: sessionId ?? undefined } })
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
                            <div className={cn('max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6', message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
                                {message.parts.map((part, index) => {
                                    if (part.type === 'text') return <span key={index}>{part.text}</span>
                                    if (message.role !== 'assistant' || part.type !== 'reasoning' || typeof part.text !== 'string' || !isDesktopSummaryMetadata(part.providerMetadata)) return null
                                    const streaming = status === 'streaming' && messageIndex === transcript.length - 1 && index === message.parts.length - 1
                                    return part.text || streaming ? <ReasoningStep key={index} text={part.text} isStreaming={streaming} /> : null
                                })}
                            </div>
                        </div>
                    ))}
                    {busy && <div className="text-sm text-muted-foreground">{agent.name} is working…</div>}
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
                <form onSubmit={submit} className="mx-auto flex max-w-3xl items-end gap-2">
                    <label htmlFor="desktop-message" className="sr-only">Message {agent.name}</label>
                    <Textarea
                        id="desktop-message"
                        rows={2}
                        maxLength={20_000}
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
                    <Button type="submit" disabled={!input.trim() || busy || !ready}>Send</Button>
                </form>
            </div>
        </div>
    )
}
