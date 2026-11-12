'use client'

import { useEffect, useRef, useState } from 'react'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { MessagesSquare } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { createDesktopForemanConversation, listDesktopForemanConversations } from '@/lib/desktop/foreman-client/runtime-client'
import { useDesktopLocale } from '../DesktopLocale'

export function DesktopForemanConversations({ chat, disabled, onSelect }: {
    chat: DesktopForemanChatRef
    disabled: boolean
    onSelect: (chat: DesktopForemanChatRef | null) => Promise<void>
}) {
    const { t } = useDesktopLocale()
    const lifetime = useRef<AbortController | null>(null)
    const newRequest = useRef<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [conversations, setConversations] = useState<Awaited<ReturnType<typeof listDesktopForemanConversations>>>([])
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        return () => controller.abort()
    }, [])

    async function load() {
        const lifetimeSignal = lifetime.current?.signal
        if (!lifetimeSignal || lifetimeSignal.aborted) return
        setError(null)
        try {
            const rows = await listDesktopForemanConversations(AbortSignal.any([lifetimeSignal, AbortSignal.timeout(10_000)]))
            if (!lifetimeSignal.aborted) setConversations(rows.filter(row => row.chat.workspaceId === chat.workspaceId))
        } catch { if (!lifetimeSignal.aborted) setError(t('foreman.conversationsUnavailable')) }
    }

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

    return <>
        <DropdownMenu onOpenChange={open => { if (open) void load() }}>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || busy}
                    aria-label={t('foreman.conversations')} title={t('foreman.conversations')}><MessagesSquare /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => { void open() }}>{t('foreman.newConversation')}</DropdownMenuItem>
                {!!conversations.length && <DropdownMenuSeparator />}
                {conversations.map(row => <DropdownMenuItem key={row.chat.chatId} disabled={row.chat.chatId === chat.chatId}
                    onSelect={() => { void open(row.home ? null : row.chat) }}>
                    <span className="truncate">{row.home ? t('foreman.mainConversation') : row.title ?? t('foreman.newConversation')}</span>
                </DropdownMenuItem>)}
            </DropdownMenuContent>
        </DropdownMenu>
        {error && <span role="alert" className="max-w-40 truncate text-xs text-destructive" title={error}>{error}</span>}
    </>
}
