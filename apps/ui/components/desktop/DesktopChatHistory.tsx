'use client'

import { useDesktopLocale } from './DesktopLocale'
import { useEffect, useId, useState } from 'react'
import { Badge } from '@rerun/ui/primitives'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CalendarClock, LoaderIcon, MessageCircle, MessageCircleQuestionIcon, WebhookIcon } from '@/lib/icons'
import {
    DESKTOP_CHAT_FILTERS,
    desktopChatHistorySchema,
    filterDesktopChats,
    groupDesktopChats,
    isAutomatedChat,
    type DesktopChatFilter,
    type DesktopChatHistory,
    type DesktopChatHistoryConversation,
} from '@/lib/desktop/chat-history'
import { fullDateTime, messageTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { DesktopNeedsChats } from './DesktopNeedsChats'
import { useDesktopPendingInbox } from './useDesktopPendingInbox'

function ChatHistoryRow({ conversation, active, busy, onOpen }: {
    conversation: DesktopChatHistoryConversation
    active: boolean
    busy: boolean
    onOpen: () => void
}) {
    const automated = isAutomatedChat(conversation)
    const SourceIcon = conversation.source === 'trigger' ? WebhookIcon : CalendarClock
    const updatedAt = Number.isFinite(Date.parse(conversation.updatedAt)) ? conversation.updatedAt : null
    return (
        <button type="button" disabled={busy} aria-current={active ? 'true' : undefined} data-thread-row={conversation.id} onClick={onOpen}
            className={cn('flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40 disabled:opacity-50', active && 'bg-muted/60')}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                    {automated && <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span title={conversation.title} className="min-w-0 flex-1 truncate text-sm font-medium">{conversation.title}</span>
                    {conversation.needsYou && <Badge size="xs" tone="orange" glow={false} className="shrink-0">Needs you</Badge>}
                </span>
                {conversation.firstMessage && <span className="truncate text-xs text-muted-foreground">{conversation.firstMessage}</span>}
                {conversation.needsYou && conversation.pendingQuestion && (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <MessageCircleQuestionIcon aria-hidden className="size-3 shrink-0" />
                        <span className="truncate">{conversation.pendingQuestion}</span>
                    </span>
                )}
            </span>
            {updatedAt && <time dateTime={updatedAt} title={`Updated ${fullDateTime(updatedAt)}`}
                className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{messageTime(updatedAt)}</time>}
        </button>
    )
}

function NeedsFilterNote({ onRetry }: { onRetry: () => void }) {
    return (
        <div role="status" className="flex flex-col items-center gap-2 px-3 py-5 text-center text-xs text-muted-foreground">
            <span>Pending requests could not be loaded.</span>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        </div>
    )
}

function ClassificationFilterNote({ onRetry }: { onRetry: () => void }) {
    return (
        <div role="status" className="flex flex-col items-center gap-2 px-3 py-5 text-center text-xs text-muted-foreground">
            <span>Conversation types could not be loaded.</span>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        </div>
    )
}

function ChatHistoryList({ history, filter, query, selectedId, busy, onSelect, onRetry }: {
    history: DesktopChatHistory
    filter: DesktopChatFilter
    query: string
    selectedId: string | null
    busy: boolean
    onSelect: (id: string) => void
    onRetry: () => void
}) {
    const { t } = useDesktopLocale()
    const shown = filterDesktopChats(history.conversations, filter, query)
    const groups = groupDesktopChats(shown)
    const questionsUnavailable = history.questions === 'unavailable'
    const classificationUnavailable = (filter === 'chats' || filter === 'automations') && history.enrichment === 'unavailable'
    const empty = query.trim()
        ? 'No matching conversations.'
        : filter === 'needs' ? t('emptyNeeds')
            : filter === 'automations' ? t('emptyAutomations')
                : filter === 'chats' ? t('emptyThreads')
                    : 'No thread yet.'
    return (
        <div className="max-h-[min(420px,50dvh)] min-h-0 overflow-y-auto">
            {history.enrichment === 'unavailable' && !classificationUnavailable && (
                <p className="px-2.5 py-1 text-[11px] text-muted-foreground">Recent activity could not be read. Showing saved dates.</p>
            )}
            {filter === 'needs' && questionsUnavailable && <NeedsFilterNote onRetry={onRetry} />}
            {classificationUnavailable ? <ClassificationFilterNote onRetry={onRetry} /> : groups.map(({ day, entries }) => (
                <div key={day} className="pb-1">
                    <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{day}</p>
                    {entries.map(conversation => (
                        <ChatHistoryRow key={conversation.id} conversation={conversation} active={selectedId === conversation.id}
                            busy={busy} onOpen={() => onSelect(conversation.id)} />
                    ))}
                </div>
            ))}
            {shown.length === 0 && !classificationUnavailable && !(filter === 'needs' && questionsUnavailable) && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">{empty}</p>
            )}
        </div>
    )
}

function ChatHistoryPanel({ agentId, selectedId, busy, onSelect, titleId, descriptionId, initialFilter = 'all' }: {
    initialFilter?: DesktopChatFilter
    agentId: string
    selectedId: string | null
    busy: boolean
    onSelect: (id: string) => void
    titleId: string
    descriptionId: string
}) {
    const { t } = useDesktopLocale()
    const [history, setHistory] = useState<DesktopChatHistory | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<DesktopChatFilter>(initialFilter)
    const inbox = useDesktopPendingInbox(true, [agentId])

    useEffect(() => {
        const controller = new AbortController()
        void (async () => {
            try {
                const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/chat-history`, { signal: controller.signal, cache: 'no-store' })
                const body = await response.json().catch(() => ({}))
                if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load conversations')
                const parsed = desktopChatHistorySchema.parse(body)
                if (!controller.signal.aborted) {
                    setHistory(parsed)
                    setError(null)
                }
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load conversations')
            }
        })()
        return () => controller.abort()
    }, [agentId, attempt])

    const retry = () => {
        setError(null)
        setHistory(null)
        setAttempt(value => value + 1)
    }

    return (
        <>
            <div className="shrink-0 px-2 pt-1">
                <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
                    <MessageCircle aria-hidden className="size-4 text-muted-foreground" />
                    {t('threads')}
                </h2>
                <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">Dates show when chats were last updated.</p>
            </div>
            <Input className="shrink-0" type="search" aria-label={t('searchChats')} placeholder={t('searchChats') + '…'} value={query}
                onChange={event => setQuery(event.target.value)} />
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-0.5 py-1">
                {DESKTOP_CHAT_FILTERS.map(({ value }) => (
                    <Chip key={value} selected={filter === value} onClick={() => setFilter(value)}>
                        {t(value)}
                        {value === 'needs' && inbox.status === 'ready' && !inbox.unavailableAgentIds.includes(agentId) && (
                            <span className="ml-1 tabular-nums text-muted-foreground/70">
                                {inbox.items.length}
                            </span>
                        )}
                    </Chip>
                ))}
            </div>
            {filter === 'needs' ? <DesktopNeedsChats agentId={agentId} query={query} onSelect={onSelect} busy={busy} inbox={inbox} /> : error ? (
                <div role="alert" className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs">
                    <p className="text-destructive">{error}</p>
                    <Button type="button" size="sm" variant="outline" onClick={retry}>Retry conversations</Button>
                </div>
            ) : history === null ? (
                <p role="status" className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                    <LoaderIcon aria-hidden className="size-3.5 animate-spin" />
                    Loading conversations…
                </p>
            ) : (
                <ChatHistoryList history={history} filter={filter} query={query} selectedId={selectedId} busy={busy} onSelect={onSelect} onRetry={retry} />
            )}
        </>
    )
}

export function DesktopChatHistory({ agentId, count, selectedId, busy, onSelect, control }: {
    control?: { needsRequest: number | null; active: boolean; onOpenChange: (open: boolean) => void }
    agentId: string
    count?: number
    selectedId: string | null
    busy: boolean
    onSelect: (id: string) => void
}) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useState(false)
    const [seenRequest, setSeenRequest] = useState<number | null>(null)
    const [initialFilter, setInitialFilter] = useState<DesktopChatFilter>('all')
    if (control?.active && control.needsRequest !== null && control.needsRequest !== seenRequest) {
        setSeenRequest(control.needsRequest); setInitialFilter('needs'); setOpen(true)
    }
    const visible = open && control?.active !== false
    useEffect(() => { control?.onOpenChange(visible); return () => control?.onOpenChange(false) }, [visible, control?.onOpenChange])
    useEffect(() => { if (control?.active === false) setOpen(false) }, [control?.active])
    const changeOpen = (next: boolean) => { if (next) setInitialFilter('all'); setOpen(next) }
    const titleId = useId()
    const descriptionId = useId()
    return (
        <Popover open={visible} onOpenChange={changeOpen}>
            <PopoverTrigger asChild>
                <Button type="button" size="icon" variant="outline" className="size-10 rounded-full border-border/50 bg-background/85 shadow-sm" title={t('threads')} disabled={busy}
                    aria-label={count === undefined ? 'Conversation history' : `Conversation history (${count})`}>
                    <MessageCircle aria-hidden className="size-4 text-muted-foreground" /><span className="sr-only">Chats</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" collisionPadding={12}
                onInteractOutside={event => { if (document.querySelector('[role="alertdialog"][data-state="open"]')) event.preventDefault() }}
                onEscapeKeyDown={event => { if (document.querySelector('[role="alertdialog"][data-state="open"]')) event.preventDefault() }} aria-labelledby={titleId} aria-describedby={descriptionId}
                className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] gap-2 overflow-hidden p-2">
                {visible && <ChatHistoryPanel key={`${agentId}/${seenRequest}`} initialFilter={initialFilter} agentId={agentId} selectedId={selectedId} busy={busy}
                    titleId={titleId} descriptionId={descriptionId}
                    onSelect={id => { onSelect(id); setOpen(false) }} />}
            </PopoverContent>
        </Popover>
    )
}
