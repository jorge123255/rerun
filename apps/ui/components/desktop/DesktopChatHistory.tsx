'use client'

import { useDesktopLocale } from './DesktopLocale'
import { useEffect, useId, useState } from 'react'
import { Badge } from '@rerun/ui/primitives'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { CalendarClock, EllipsisIcon, MessageCircle, MessageCircleQuestionIcon, PlusIcon, WebhookIcon, XIcon } from '@/lib/icons'
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
import { fullDateTime, messageTime } from '@rerun/i18n/format'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { cn } from '@/lib/utils'
import { DesktopSessionRenameField, type DesktopSessionRename } from './DesktopSessionRename'
import { DesktopNeedsChats, matchingPendingChats } from './DesktopNeedsChats'
import { useDesktopPendingInbox } from './useDesktopPendingInbox'
import type { DesktopSessionView } from './DesktopApp'

function ChatHistoryRow({ conversation, detail, verifiedRunStatus, pendingSummary, active, busy, onOpen }: {
    conversation: DesktopChatHistoryConversation
    detail?: DesktopSessionView
    verifiedRunStatus: boolean
    pendingSummary?: string
    active: boolean
    busy: boolean
    onOpen: () => void
}) {
    const { language, t } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const automated = isAutomatedChat(conversation)
    const matchingDetail = detail?.source === conversation.source ? detail : undefined
    const routine = automated && matchingDetail?.automationName !== conversation.title ? matchingDetail?.automationName : null
    const caller = conversation.source === 'agent' || conversation.source === 'delegate' ? matchingDetail?.originAgentName : null
    const status = verifiedRunStatus ? matchingDetail?.runStatus : null
    const SourceIcon = conversation.source === 'trigger' ? WebhookIcon : CalendarClock
    const updatedAt = Number.isFinite(Date.parse(conversation.updatedAt)) ? conversation.updatedAt : null
    return (
        <button type="button" disabled={busy} aria-current={active ? 'true' : undefined} data-thread-row={conversation.id} onClick={onOpen}
            className={cn('flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40 disabled:opacity-50', active && 'bg-muted/60')}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                    {automated && !routine && <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span title={conversation.title} className={cn('min-w-0 flex-1 truncate text-sm font-medium',
                        status === 'error' ? 'text-destructive' : automated && conversation.automationOutcome === 'nothing' && 'text-muted-foreground')}>{conversation.title}</span>
                    {status === 'running' && <Badge size="xs" tone="green" glow={false} className="shrink-0">{t('running')}</Badge>}
                    {status === 'error' && <span className="sr-only">{t('error')}</span>}
                    {pendingSummary !== undefined && <Badge size="xs" tone="orange" glow={false} className="shrink-0">{t('needs')}</Badge>}
                </span>
                {conversation.firstMessage && <span className="truncate text-xs text-muted-foreground">{conversation.firstMessage}</span>}
                {routine && <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <SourceIcon aria-hidden className="size-3 shrink-0" />
                    <span className="truncate">{routine}</span>
                </span>}
                {caller && <span className="truncate text-xs text-muted-foreground">{t('threadHistory.startedBy', { name: caller })}</span>}
                {pendingSummary && (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <MessageCircleQuestionIcon aria-hidden className="size-3 shrink-0" />
                        <span className="truncate">{pendingSummary}</span>
                    </span>
                )}
            </span>
            {updatedAt && <time dateTime={updatedAt} title={t('threadHistory.updated', { date: fullDateTime(updatedAt, locale) })}
                className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{messageTime(updatedAt, locale)}</time>}
        </button>
    )
}

function ClassificationFilterNote({ onRetry, partial }: { onRetry: () => void; partial: boolean }) {
    const { t } = useDesktopLocale()
    return (
        <div role="status" className="flex flex-col items-center gap-2 px-3 py-5 text-center text-xs text-muted-foreground">
            <span>{t(partial ? 'threadHistory.partialTypes' : 'threadHistory.unavailableTypes')}</span>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('threadHistory.retry')}</Button>
        </div>
    )
}

function ChatHistoryList({ history, details, verifiedRunStatus, filter, query, selectedId, busy, pendingChatSummaries, inlinePendingIds, onSelect, onRetry, rename }: {
    history: DesktopChatHistory
    details: ReadonlyMap<string, DesktopSessionView>
    verifiedRunStatus: boolean
    pendingChatSummaries?: ReadonlyMap<string, string>
    inlinePendingIds: ReadonlySet<string>
    filter: Exclude<DesktopChatFilter, 'needs'>
    query: string
    selectedId: string | null
    busy: boolean
    onSelect: (id: string) => void
    onRetry: () => void
    rename?: DesktopSessionRename
}) {
    const { language, t } = useDesktopLocale()
    const conversations = history.conversations.map(row => {
        const current = details.get(row.id)
        if (current?.automationOutcome && current.source === row.source && isAutomatedChat(row))
            return { ...row, title: current.title, automationOutcome: current.automationOutcome }
        return current?.titleEdited ? { ...row, title: current.title } : row
    })
    const editingId = rename?.target?.surface === 'history' ? rename.target.id : null
    const filtered = filterDesktopChats(conversations, filter, query).filter(row => !inlinePendingIds.has(row.id))
    // Keep the field mounted if a save changes the title used by the current search.
    const editing = editingId ? conversations.find(row => row.id === editingId) : undefined
    const shown = editing && !filtered.some(row => row.id === editingId) ? [...filtered, editing] : filtered
    const groups = groupDesktopChats(shown, { locale: desktopLocaleTag(language.locale), unknownDate: t('threadHistory.dateUnavailable') })
    const classificationUnavailable = (filter === 'chats' || filter === 'automations') && history.enrichment === 'unavailable'
    const empty = query.trim()
        ? t('threadHistory.noMatches')
        : t(filter === 'automations' ? 'emptyAutomations' : 'emptyThreads')
    return (
        <>
            {history.enrichment === 'unavailable' && !classificationUnavailable && (
                <p className="px-2.5 py-1 text-[11px] text-muted-foreground">{t('threadHistory.unavailableActivity')}</p>
            )}
            {classificationUnavailable && <ClassificationFilterNote onRetry={onRetry}
                partial={history.conversations.some(row => row.kind !== 'general' && row.source !== null)} />}
            {groups.map(({ day, entries }) => (
                <div key={day} className="pb-1">
                    <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{day}</p>
                    {entries.map(conversation => (
                        rename && editingId === conversation.id
                            ? <DesktopSessionRenameField key={conversation.id} title={conversation.title} rename={rename} />
                            : <div key={conversation.id} className="flex items-center gap-1">
                                <ChatHistoryRow conversation={conversation} detail={details.get(conversation.id)}
                                    verifiedRunStatus={verifiedRunStatus} pendingSummary={pendingChatSummaries?.get(conversation.id)}
                                    active={selectedId === conversation.id} busy={busy} onOpen={() => onSelect(conversation.id)} />
                                {rename && conversation.kind !== 'general' && <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('sessionRename.label') + ' · ' + conversation.title}>
                                            <EllipsisIcon aria-hidden />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem onSelect={() => rename.start({ id: conversation.id, surface: 'history' })}>{t('sessionRename.rename')}</DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>}
                            </div>
                    ))}
                </div>
            ))}
            {shown.length === 0 && inlinePendingIds.size === 0 && !classificationUnavailable && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">{empty}</p>
            )}
        </>
    )
}

function ChatHistoryPanel({ agentId, selectedId, sessions, verifiedRunStatus, busy, pendingChatSummaries, onSelect, onCreate, onClose, titleId, descriptionId, rename, initialFilter = 'all' }: {
    initialFilter?: DesktopChatFilter
    rename?: DesktopSessionRename
    agentId: string
    sessions: readonly DesktopSessionView[]
    verifiedRunStatus: boolean
    pendingChatSummaries?: ReadonlyMap<string, string>
    selectedId: string | null
    busy: boolean
    onSelect: (id: string) => void
    onCreate?: () => void
    onClose: () => void
    titleId: string
    descriptionId: string
}) {
    const { t } = useDesktopLocale()
    const [history, setHistory] = useState<DesktopChatHistory | null>(null)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<DesktopChatFilter>(initialFilter)
    const inbox = useDesktopPendingInbox(true, [agentId])
    const inlinePendingIds = new Set(filter === 'all' ? matchingPendingChats(inbox.items, query).map(item => item.sessionId) : [])
    const details = new Map(sessions.filter(session => session.agentId === agentId && session.source).map(session => [session.id, session]))

    useEffect(() => {
        const controller = new AbortController()
        void (async () => {
            try {
                const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/chat-history?view=saved`, { signal: controller.signal, cache: 'no-store' })
                if (!response.ok) throw new Error('Conversation history unavailable')
                const parsed = desktopChatHistorySchema.parse(await response.json())
                if (!controller.signal.aborted) {
                    setHistory(parsed)
                    setError(false)
                }
            } catch {
                if (!controller.signal.aborted) setError(true)
            }
        })()
        return () => controller.abort()
    }, [agentId, attempt])

    const retry = () => {
        setError(false)
        setHistory(null)
        setAttempt(value => value + 1)
    }

    return (
        <>
            <div className="shrink-0 px-2 pt-1">
                <div className="flex items-center justify-between gap-2">
                    <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
                        <MessageCircle aria-hidden className="size-4 text-muted-foreground" />
                        {t('threads')}
                    </h2>
                    <div className="flex shrink-0 items-center gap-1.5">
                        {onCreate && <Button type="button" variant="outline" size="sm" aria-label={t('newThread')} disabled={busy} onClick={onCreate}>
                            <PlusIcon aria-hidden className="size-3.5" /> {t('newThread')}
                        </Button>}
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('threadHistory.close')} onClick={onClose}>
                            <XIcon aria-hidden />
                        </Button>
                    </div>
                </div>
                <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">{t('threadHistory.dates')}</p>
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
            <div className="max-h-[min(420px,50dvh)] min-h-0 space-y-0.5 overflow-y-auto px-1 pb-2">
                {(filter === 'all' || filter === 'needs') && <DesktopNeedsChats key={filter} inline={filter === 'all'}
                    agentId={agentId} query={query} onSelect={onSelect} busy={busy} inbox={inbox} />}
                {filter !== 'needs' && (error ? (
                    <div role="alert" className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs">
                        <p className="text-destructive">{t('threadHistory.loadFailed')}</p>
                        <Button type="button" size="sm" variant="outline" onClick={retry}>{t('retryConversations')}</Button>
                    </div>
                ) : history === null ? (
                    <div role="status" aria-busy="true">
                        <span className="sr-only">{t('threadHistory.loading')}</span>
                        <SkeletonPanelRows rows={4} aria-hidden="true" />
                    </div>
                ) : (
                    <ChatHistoryList history={history} details={details} verifiedRunStatus={verifiedRunStatus} filter={filter} query={query} selectedId={selectedId} busy={busy} pendingChatSummaries={pendingChatSummaries}
                        inlinePendingIds={inlinePendingIds} onSelect={onSelect} onRetry={retry} rename={rename} />
                ))}
            </div>
        </>
    )
}

export function DesktopChatHistory({ agentId, count, selectedId, sessions = [], verifiedRunStatus = false, busy, pendingChatSummaries, onSelect, onCreate, control, rename }: {
    rename?: DesktopSessionRename
    control?: { needsRequest: number | null; active: boolean; onOpenChange: (open: boolean) => void }
    agentId: string
    sessions?: readonly DesktopSessionView[]
    verifiedRunStatus?: boolean
    pendingChatSummaries?: ReadonlyMap<string, string>
    count?: number
    selectedId: string | null
    busy: boolean
    onSelect: (id: string) => boolean | void
    onCreate?: () => boolean
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
    const changeOpen = (next: boolean) => {
        if (!next && rename?.target?.surface === 'history') {
            if (rename.status === 'saving') return
            rename.cancel()
        }
        if (next) setInitialFilter('all')
        setOpen(next)
    }
    const titleId = useId()
    const descriptionId = useId()
    return (
        <Popover open={visible} onOpenChange={changeOpen}>
            <PopoverTrigger asChild>
                <Button type="button" size="icon" variant="outline" className="size-10 rounded-full border-border/50 bg-background/85 shadow-sm" title={t('threads')} disabled={busy}
                    aria-label={count === undefined ? t('threadHistory.label') : t('threadHistory.labelWithCount', { count })}>
                    <MessageCircle aria-hidden className="size-4 text-muted-foreground" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" collisionPadding={12}
                onInteractOutside={event => {
                    if (rename?.target?.surface === 'history' || document.querySelector('[role="alertdialog"][data-state="open"]')) event.preventDefault()
                }}
                onEscapeKeyDown={event => {
                    if (rename?.target?.surface === 'history' || document.querySelector('[role="alertdialog"][data-state="open"]')) event.preventDefault()
                }} aria-labelledby={titleId} aria-describedby={descriptionId}
                className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] gap-2 overflow-hidden p-2">
                {visible && <ChatHistoryPanel key={`${agentId}/${seenRequest}`} initialFilter={initialFilter} agentId={agentId} selectedId={selectedId} busy={busy} pendingChatSummaries={pendingChatSummaries}
                    sessions={sessions} verifiedRunStatus={verifiedRunStatus} rename={rename}
                    titleId={titleId} descriptionId={descriptionId}
                    onClose={() => changeOpen(false)}
                    onCreate={onCreate && (() => { if (onCreate()) changeOpen(false) })}
                    onSelect={id => { if (onSelect(id) !== false) changeOpen(false) }} />}
            </PopoverContent>
        </Popover>
    )
}
