'use client'

import { useEffect, useRef, useState } from 'react'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { ChevronLeft, History, MessagesSquare, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { createDesktopForemanConversation, listDesktopForemanConversations } from '@/lib/desktop/foreman-client/runtime-client'
import { useDesktopLocale } from '../DesktopLocale'

/**
 * Every conversation with the Chief of Staff behind the clock: General, the one that never closes,
 * pinned on top, then its threads. While a thread is on screen, a crumb names it and leads back.
 */
export function DesktopForemanConversations({ chat, thread = false, disabled, onSelect }: {
    chat: DesktopForemanChatRef
    // The conversation on screen is a thread rather than General.
    thread?: boolean
    disabled: boolean
    onSelect: (chat: DesktopForemanChatRef | null) => Promise<void>
}) {
    const { t } = useDesktopLocale()
    const lifetime = useRef<AbortController | null>(null)
    const newRequest = useRef<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [conversations, setConversations] = useState<Awaited<ReturnType<typeof listDesktopForemanConversations>>>([])
    const [error, setError] = useState<string | null>(null)

    async function load() {
        const lifetimeSignal = lifetime.current?.signal
        if (!lifetimeSignal || lifetimeSignal.aborted) return
        setError(null)
        try {
            const rows = await listDesktopForemanConversations(AbortSignal.any([lifetimeSignal, AbortSignal.timeout(10_000)]))
            if (!lifetimeSignal.aborted) setConversations(rows.filter(row => row.chat.workspaceId === chat.workspaceId))
        } catch { if (!lifetimeSignal.aborted) setError(t('foreman.conversationsUnavailable')) }
    }
    const loadRef = useRef(load)
    loadRef.current = load
    useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        // General needs no list until the clock opens. A thread reads it once, for its own title.
        if (thread) void loadRef.current()
        return () => controller.abort()
    }, [thread, chat.chatId])

    async function open(target?: DesktopForemanChatRef | null) {
        const lifetimeSignal = lifetime.current?.signal
        if (!lifetimeSignal || lifetimeSignal.aborted || busy) return
        setBusy(true)
        setError(null)
        try {
            const next = target === undefined
                ? await createDesktopForemanConversation(chat.workspaceId, newRequest.current ??= crypto.randomUUID(),
                    AbortSignal.any([lifetimeSignal, AbortSignal.timeout(10_000)]))
                : target
            if (lifetimeSignal.aborted) return
            await onSelect(next)
            if (target === undefined) newRequest.current = null
        } catch { if (!lifetimeSignal.aborted) setError(t('foreman.conversationUnavailable')) }
        finally { if (!lifetimeSignal.aborted) setBusy(false) }
    }

    const threads = conversations.filter(row => !row.home)
    const current = threads.find(row => row.chat.chatId === chat.chatId)
    return <>
        {thread && <span data-foreman-thread-crumb className="flex min-w-0 items-center gap-1">
            <Button type="button" variant="ghost" size="xs" className="shrink-0 px-1 text-muted-foreground" disabled={disabled || busy}
                aria-label={t('foreman.backToGeneral')} onClick={() => { void open(null) }}>
                <ChevronLeft className="size-4" />{t('foreman.mainConversation')}
            </Button>
            <span aria-hidden className="text-muted-foreground/50">/</span>
            <span className="max-w-32 min-w-0 truncate text-sm font-medium">{current?.title ?? t('foreman.newConversation')}</span>
        </span>}
        <DropdownMenu onOpenChange={open => { if (open) void load() }}>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || busy}
                    aria-label={t('foreman.conversations')} title={t('foreman.conversations')}><History /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="flex items-center justify-between gap-2">
                    {t('foreman.conversations')}
                    <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => { void open() }}><Plus className="size-3.5" />{t('foreman.newConversation')}</Button>
                </DropdownMenuLabel>
                <DropdownMenuItem aria-current={!thread ? 'true' : undefined} className="gap-2 font-medium" onSelect={() => { void open(null) }}>
                    <MessagesSquare className="size-3.5" />{t('foreman.mainConversation')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {threads.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t('foreman.noThreads')}</p>}
                {threads.map(row => <DropdownMenuItem key={row.chat.chatId} aria-current={row.chat.chatId === chat.chatId ? 'true' : undefined}
                    onSelect={() => { if (row.chat.chatId !== chat.chatId) void open(row.chat) }}>
                    <span className="truncate">{row.title ?? t('foreman.newConversation')}</span>
                </DropdownMenuItem>)}
            </DropdownMenuContent>
        </DropdownMenu>
        {error && <span role="alert" className="max-w-40 truncate text-xs text-destructive" title={error}>{error}</span>}
    </>
}
