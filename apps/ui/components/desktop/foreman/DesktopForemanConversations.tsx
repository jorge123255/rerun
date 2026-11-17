'use client'

import { useEffect, useRef, useState } from 'react'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { ChevronLeft, History, MessageCircle, MessagesSquare, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { listDesktopForemanConversations } from '@/lib/desktop/foreman-client/runtime-client'
import { messageDayLabel, messageTime } from '@rerun/i18n/format'
import { ScrollFade } from '@rerun/ui/primitives'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'

type Conversation = Awaited<ReturnType<typeof listDesktopForemanConversations>>[number]
/** A saved task as General shows it: under the message it started after, as Rerun Cloud does (upstream #201-#203). */
export type DesktopForemanGeneralThread = { chat: DesktopForemanChatRef; title: string | null; createdAt: string; updatedAt: string }
/** Where the thread on screen stands: answering, waiting for the person, or at rest. */
export type DesktopForemanThreadState = 'live' | 'needs' | 'quiet'

// The task a first message just saved: its panel mounts after this one is gone, and takes the caret.
let newTaskFocus: string | null = null
/** The conversation about to open keeps the caret in its composer. */
export function requestDesktopForemanNewTaskFocus(chatId: string | null) { newTaskFocus = chatId }
/** True once, for the conversation « New task » just opened. */
export function takeDesktopForemanNewTaskFocus(chatId: string) {
    if (newTaskFocus !== chatId) return false
    newTaskFocus = null
    return true
}

/**
 * Every conversation with the Chief of Staff: General, the one that never closes, and its threads.
 * One owner for the list, the way into a conversation and « New task », shared by the header's
 * button, the list behind the clock and the crumb under the tabs.
 */
export function useDesktopForemanConversations({ chat, thread = false, emptyThread = false, draft = false, onSelect, onNewTask, onFocusComposer }: {
    chat: DesktopForemanChatRef
    // The conversation on screen is a thread rather than General.
    thread?: boolean
    // That thread has no message yet: « New task » returns to it rather than opening another.
    emptyThread?: boolean
    // The thread on screen is a new task nobody sent a message in: it is not saved, and has no row of its own on the server.
    draft?: boolean
    onSelect?: (chat: DesktopForemanChatRef | null) => Promise<void>
    // Opens the unsaved new task. Nothing is created until its first message is sent.
    onNewTask?: () => void
    onFocusComposer?: () => void
}) {
    const { t } = useDesktopLocale()
    const lifetime = useRef<AbortController | null>(null)
    const [busy, setBusy] = useState(false)
    const [conversations, setConversations] = useState<Conversation[]>([])
    const [error, setError] = useState<string | null>(null)
    const enabled = !!onSelect

    // `quiet` is the read General makes for its branches: nobody asked for it, so a failure says nothing.
    async function load(quiet = false) {
        const lifetimeSignal = lifetime.current?.signal
        if (!lifetimeSignal || lifetimeSignal.aborted) return
        if (!quiet) setError(null)
        try {
            const rows = await listDesktopForemanConversations(AbortSignal.any([lifetimeSignal, AbortSignal.timeout(10_000)]))
            if (!lifetimeSignal.aborted) setConversations(rows.filter(row => row.chat.workspaceId === chat.workspaceId))
        } catch { if (!quiet && !lifetimeSignal.aborted) setError(t('foreman.conversationsUnavailable')) }
    }
    const loadRef = useRef(load)
    loadRef.current = load
    useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        // A thread reads the list once, for its own title; General reads it for the branches of its tasks.
        if (!draft && enabled) void loadRef.current(!thread)
        return () => controller.abort()
    }, [thread, draft, enabled, chat.chatId])

    async function open(target: DesktopForemanChatRef | null) {
        const lifetimeSignal = lifetime.current?.signal
        if (!onSelect || !lifetimeSignal || lifetimeSignal.aborted || busy) return
        setBusy(true)
        setError(null)
        try { await onSelect(target) }
        catch { if (!lifetimeSignal.aborted) setError(t('foreman.conversationUnavailable')) }
        finally { if (!lifetimeSignal.aborted) setBusy(false) }
    }
    // « New task » saves nothing: it opens a draft, or goes back to the composer of the empty task already on screen.
    function newTask() {
        if (!onSelect || busy) return
        if (thread && emptyThread) onFocusComposer?.()
        else onNewTask?.()
    }

    // A task nobody ever wrote in (left behind before « New task » became a draft) stays out of the
    // list unless it is the one on screen. Nothing is deleted.
    const threads = conversations.filter(row => !row.home && (!!row.updatedAt || row.title !== null || !!row.hasDraft || row.chat.chatId === chat.chatId))
    // What General shows under the message each task started after: saved tasks only. A task nobody
    // wrote in has no first message to date it, and the unsaved draft has no row at all.
    const branches: DesktopForemanGeneralThread[] = thread ? [] : threads.flatMap(row => row.startedAt && row.chat.chatId !== chat.chatId
        ? [{ chat: row.chat, title: row.title, createdAt: row.startedAt, updatedAt: row.updatedAt ?? row.startedAt }] : [])
    return {
        chat, thread, draft, enabled, busy, error, threads, branches, load: () => load(), focusComposer: () => onFocusComposer?.(),
        title: threads.find(row => row.chat.chatId === chat.chatId)?.title ?? null,
        newTask: async () => newTask(),
        openGeneral: () => open(null),
        openThread: (target: DesktopForemanChatRef) => target.chatId === chat.chatId ? Promise.resolve() : open(target),
    }
}
export type DesktopForemanConversationsController = ReturnType<typeof useDesktopForemanConversations>

/** « New task » in the header, as upstream ForemanHeader has it. */
export function DesktopForemanNewTask({ conversations, disabled }: { conversations: DesktopForemanConversationsController; disabled: boolean }) {
    const { t } = useDesktopLocale()
    return <Button type="button" size="sm" data-foreman-new-task disabled={disabled || conversations.busy} onClick={() => { void conversations.newTask() }}>
        <Plus />{t('foreman.newTask')}
    </Button>
}

/**
 * Under the tabs while a thread is on screen: where it hangs, and the way back to General.
 * Markup from upstream apps/ui/components/foreman/ForemanThreadCrumb.tsx, the state dot from
 * apps/ui/components/agent/sheet/OpenChatsTabs.tsx.
 */
export function DesktopForemanThreadCrumb({ conversations, state, disabled }: {
    conversations: DesktopForemanConversationsController; state: DesktopForemanThreadState; disabled: boolean
}) {
    const { t } = useDesktopLocale()
    // It comes in from the side General is on, quickly; with "Reduce motion" on it is simply there.
    return <div data-foreman-thread-crumb className="flex h-10 min-w-0 items-center gap-1 px-2 animate-in fade-in-0 slide-in-from-left-2 duration-200 ease-out motion-reduce:animate-none">
        <Button type="button" variant="ghost" size="sm" className="shrink-0 px-1.5 text-muted-foreground" disabled={disabled || conversations.busy}
            aria-label={t('foreman.backToGeneral')} onClick={() => { void conversations.openGeneral() }}>
            <ChevronLeft className="size-4" />{t('foreman.mainConversation')}
        </Button>
        <span aria-hidden className="text-muted-foreground/50">/</span>
        {state !== 'quiet' && <span data-foreman-thread-state={state} className="relative ml-1 flex size-1.5 shrink-0">
            {state === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />}
            <span className={cn('relative size-1.5 rounded-full', state === 'live' ? 'bg-emerald-400' : 'bg-amber-400')} />
        </span>}
        <span className="min-w-0 truncate text-sm font-medium">{conversations.title ?? t('foreman.newConversation')}</span>
    </div>
}

/**
 * Behind the clock: General pinned on top, then the threads by the day of their last message.
 * Markup from upstream apps/ui/components/foreman/ForemanHistory.tsx; its rows from ChatRow in
 * apps/ui/components/agent/sheet/AgentChatsList.tsx.
 */
export function DesktopForemanHistory({ conversations, waiting = false, disabled, inBar = false }: {
    conversations: DesktopForemanConversationsController
    // At the left of the header in the Simple view's middle, where a coworker keeps its conversations:
    // their button, and the list opens under it from the left (upstream #316).
    inBar?: boolean
    // The conversation on screen waits on the person: the dot on the button and on its row.
    waiting?: boolean
    disabled: boolean
}) {
    const { t, language: { locale } } = useDesktopLocale()
    const [open, setOpen] = useState(false)
    const { chat, thread, draft, threads, busy } = conversations
    const pick = (action: () => Promise<void>) => () => { setOpen(false); void action() }
    // A thread nobody wrote in yet has no day: it stays first, right under General.
    const undated = threads.filter(row => !row.updatedAt)
    const dated = threads.filter(row => row.updatedAt).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))
    const now = new Date()
    const days: { day: string; rows: Conversation[] }[] = []
    for (const row of dated) {
        const day = messageDayLabel(row.updatedAt!, locale, now)
        const last = days.at(-1)
        if (last?.day === day) last.rows.push(row)
        else days.push({ day, rows: [row] })
    }
    const rowOf = (row: Conversation) => {
        const active = row.chat.chatId === chat.chatId
        return <button key={row.chat.chatId} type="button" data-foreman-history-row aria-current={active ? 'true' : undefined} disabled={busy}
            onClick={pick(() => conversations.openThread(row.chat))}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors disabled:opacity-50', active ? 'bg-muted/60' : 'hover:bg-muted/40')}>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {active && waiting && <span aria-hidden data-foreman-waiting className="size-1.5 shrink-0 rounded-full bg-amber-400" />}
                <span className="truncate text-sm font-medium">{row.title ?? t('foreman.newConversation')}</span>
            </span>
            {row.updatedAt && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{messageTime(row.updatedAt, locale)}</span>}
        </button>
    }
    return <>
        <Popover open={open} onOpenChange={next => { setOpen(next); if (next) void conversations.load() }}>
            <TooltipLabeled label={t('foreman.conversations')} side="bottom">
                <PopoverTrigger asChild>
                    {inBar ? <Button type="button" variant="outline" size="icon" disabled={disabled || busy} aria-label={t('foreman.conversations')}
                        className="relative size-10 rounded-full border-border/50 bg-background/85 shadow-sm">
                        <MessageCircle aria-hidden className="size-4 text-muted-foreground" />
                        {waiting && <span aria-hidden data-foreman-waiting className="absolute top-2 right-2 size-2 rounded-full bg-amber-400 ring-2 ring-background" />}
                    </Button> : <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || busy} aria-label={t('foreman.conversations')} className="relative">
                        <History className="size-3.5" />
                        {waiting && <span aria-hidden data-foreman-waiting className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-400" />}
                    </Button>}
                </PopoverTrigger>
            </TooltipLabeled>
            {/* A child of the header, whose pointer down drags the column: a press in the list stops here. */}
            <PopoverContent align={inBar ? 'start' : 'end'} data-foreman-history onPointerDown={event => event.stopPropagation()}
                className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(360px,calc(100vw-1.5rem))] gap-0 overflow-hidden p-0 duration-150 ease-out motion-reduce:animate-none">
                <div className="flex min-h-0 flex-col">
                    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pt-3 pb-1">
                        <span className="flex items-center gap-2 pl-1 text-sm font-semibold">
                            <MessageCircle className="size-4 text-muted-foreground" />{t('foreman.conversations')}
                        </span>
                        <div className="flex items-center gap-1.5">
                            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={pick(conversations.newTask)}>
                                <Plus className="size-3.5" />{t('foreman.newTask')}
                            </Button>
                            <Button type="button" aria-label={t('foreman.close')} variant="ghost" size="icon-sm" onClick={() => setOpen(false)}><X className="size-4" /></Button>
                        </div>
                    </div>
                    <ScrollFade className="min-h-0 px-2 pb-2">
                        <div className="space-y-0.5">
                            <button type="button" data-foreman-history-row aria-current={!thread ? 'true' : undefined} disabled={busy} onClick={pick(conversations.openGeneral)}
                                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors', !thread ? 'bg-muted/60' : 'hover:bg-muted/40')}>
                                <MessagesSquare className="size-3.5 text-brand-text" />
                                <span className="min-w-0 flex-1 truncate">{t('foreman.mainConversation')}</span>
                                {!thread && waiting && <span aria-hidden data-foreman-waiting className="size-1.5 shrink-0 rounded-full bg-amber-400" />}
                            </button>
                            {/* The unsaved new task is the one on screen: it has a row while it is open, and none once it is left. */}
                            {draft && <button type="button" data-foreman-history-row data-foreman-history-draft aria-current="true" disabled={busy}
                                onClick={() => { setOpen(false); conversations.focusComposer() }}
                                className="flex w-full items-center gap-2.5 rounded-lg bg-muted/60 px-2.5 py-2 text-left transition-colors disabled:opacity-50">
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('foreman.newConversation')}</span>
                            </button>}
                            {undated.map(rowOf)}
                            {days.map(({ day, rows }) => <div key={day} className="pb-1">
                                <p data-foreman-history-day className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{day}</p>
                                {rows.map(rowOf)}
                            </div>)}
                            {threads.length === 0 && !draft && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('foreman.noThreads')}</p>}
                        </div>
                    </ScrollFade>
                </div>
            </PopoverContent>
        </Popover>
        {conversations.error && <span role="alert" className="max-w-40 truncate text-xs text-destructive" title={conversations.error}>{conversations.error}</span>}
    </>
}
