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

async function historyFor(sessionId: string): Promise<UIMessage[]> {
    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/messages`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load conversation history')
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
    const [historyError, setHistoryError] = useState<string | null>(null)

    const transport = useMemo(() => new DefaultChatTransport({
        api: '/api/desktop/chat',
        prepareSendMessagesRequest: ({ body, messages }) => ({ body: { ...body, text: lastUserText(messages) } }),
        fetch: async (url, init) => {
            const response = await fetch(url, init)
            const id = response.headers.get('x-session-id')
            if (response.ok && id) onChatSession(id)
            return response
        },
    }), [onChatSession])

    const { messages, setMessages, sendMessage, status, error } = useChat({
        id: `desktop-${agent.id}`,
        transport,
        experimental_throttle: 60,
    })

    const busy = status === 'submitted' || status === 'streaming'

    useEffect(() => {
        let cancelled = false
        if (busy) return
        if (!sessionId) {
            void Promise.resolve().then(() => {
                if (!cancelled) {
                    setMessages([])
                    setHistoryError(null)
                }
            })
        } else {
            void historyFor(sessionId).then(history => {
                if (!cancelled) {
                    setMessages(history)
                    setHistoryError(null)
                }
            }).catch(cause => {
                if (!cancelled) setHistoryError(cause instanceof Error ? cause.message : 'Could not load history')
            })
        }
        return () => { cancelled = true }
    }, [sessionId, setMessages, busy])

    function submit(event: React.FormEvent) {
        event.preventDefault()
        const text = input.trim()
        if (!text || busy) return
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
                    <DesktopCoworkerSettings agent={agent} disabled={busy} />
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onSelectSession(null)}>New chat</Button>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-6">
                <div className="mx-auto max-w-3xl space-y-4">
                    {messages.length === 0 && !busy && (
                        <div className="py-16 text-center">
                            <div className="text-sm font-medium">Start a conversation with {agent.name}</div>
                            <div className="mt-1 text-sm text-muted-foreground">Messages stream from the local engine and remain available after restart.</div>
                        </div>
                    )}
                    {messages.map((message, messageIndex) => (
                        <div key={message.id} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                            <div className={cn('max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6', message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
                                {message.parts.map((part, index) => {
                                    if (part.type === 'text') return <span key={index}>{part.text}</span>
                                    if (message.role !== 'assistant' || part.type !== 'reasoning' || typeof part.text !== 'string' || !isDesktopSummaryMetadata(part.providerMetadata)) return null
                                    const streaming = status === 'streaming' && messageIndex === messages.length - 1 && index === message.parts.length - 1
                                    return part.text || streaming ? <ReasoningStep key={index} text={part.text} isStreaming={streaming} /> : null
                                })}
                            </div>
                        </div>
                    ))}
                    {busy && <div className="text-sm text-muted-foreground">{agent.name} is working…</div>}
                    {(error || historyError) && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{historyError || error?.message}</div>}
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
                    <Button type="submit" disabled={!input.trim() || busy}>Send</Button>
                </form>
            </div>
        </div>
    )
}
