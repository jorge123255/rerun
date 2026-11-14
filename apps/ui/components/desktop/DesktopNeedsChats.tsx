'use client'

import { useEffect, useRef, useState } from 'react'
import { InboxRow } from '@rerun/ui/inbox'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { CheckCheckIcon } from '@/lib/icons'
import { conversationSearchKey } from '@/lib/desktop/chat-search'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { DESKTOP_PENDING_INBOX_URL, desktopPendingInboxSchema, type DesktopPendingInboxItem } from '@/lib/desktop/pending-inbox'
import { useDesktopPendingInbox, type DesktopPendingInboxController } from './useDesktopPendingInbox'
import { useDesktopLocale } from './DesktopLocale'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { shortRelativeTime } from '@rerun/i18n/format'

type Notice = 'busy' | 'requestChanged' | 'requestCheckFailed'

export function matchingPendingChats(items: DesktopPendingInboxItem[], query: string) {
    const needle = conversationSearchKey(query.trim())
    return needle ? items.filter(item => conversationSearchKey(`${item.title} ${item.summary}`).includes(needle)) : items
}

function inboxStatus(kind: DesktopPendingInboxItem['kind']) {
    if (kind === 'info') return 'awaiting_ack'
    if (kind === 'question') return 'awaiting_question'
    if (kind === 'approval' || kind === 'tool-install') return 'awaiting_approval'
    return 'waiting_human'
}

// AgentChatsList's Needs you surface, backed by the same durable receipts as the Mac inbox.
// Opening navigates only; Mark as read never supplies an answer or an approval.
export function DesktopNeedsChats({ agentId, query, onSelect, busy = false, inbox: supplied, inline = false }: {
    agentId: string; query: string; onSelect: (id: string) => void; busy?: boolean; inbox?: DesktopPendingInboxController; inline?: boolean
}) {
    const { language, t } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const local = useDesktopPendingInbox(!supplied, [agentId])
    const inbox = supplied ?? local
    const [notice, setNotice] = useState<Notice | null>(null)
    const [confirm, setConfirm] = useState<DesktopPendingInboxItem[] | null>(null)
    const live = useRef({ agentId, onSelect, items: inbox.items, mounted: true, busy })
    live.current = { ...live.current, agentId, onSelect, items: inbox.items, busy }
    const read = useRef<AbortController | null>(null)
    const interaction = useRef({ query, epoch: 0 })
    if (interaction.current.query !== query) { interaction.current = { query, epoch: interaction.current.epoch + 1 }; read.current?.abort() }
    useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false; read.current?.abort() } }, [agentId])
    const matches = (left: DesktopPendingInboxItem, right: DesktopPendingInboxItem) => left.id === right.id && left.agentId === right.agentId && left.sessionId === right.sessionId && left.kind === right.kind
    const current = (item: DesktopPendingInboxItem) => live.current.mounted && live.current.agentId === agentId && !isDesktopQuitting() && live.current.items.some(row => matches(row, item))
    const open = async (item: DesktopPendingInboxItem) => {
        if (!current(item)) return
        if (live.current.busy) { setNotice('busy'); return }
        read.current?.abort()
        const controller = new AbortController()
        const epoch = interaction.current.epoch
        read.current = controller
        setNotice(null)
        try {
            const response = await fetch(DESKTOP_PENDING_INBOX_URL, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) })
            if (!response.ok) throw new Error('Unavailable')
            const fresh = desktopPendingInboxSchema.parse(await response.json())
            if (!current(item) || live.current.busy || controller.signal.aborted || read.current !== controller || interaction.current.epoch !== epoch) return
            const target = fresh.items.find(row => matches(row, item))
            if (!target || fresh.unavailableAgentIds.includes(agentId)) { setNotice('requestChanged'); inbox.retry(); return }
            live.current.onSelect(target.sessionId)
        } catch { if (current(item) && !controller.signal.aborted && read.current === controller) setNotice('requestCheckFailed') }
    }
    const shown = matchingPendingChats(inbox.items, query)
    const unavailable = inbox.status === 'failed' || inbox.unavailableAgentIds.includes(agentId)
    return <>
        {!inline && inbox.items.length > 0 && <div className="flex justify-end">
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => { if (!isDesktopQuitting()) { interaction.current.epoch++; read.current?.abort(); setConfirm(inbox.items) } }}><CheckCheckIcon className="size-3.5" />{t('threadHistory.markAllRead.confirm')}</Button>
        </div>}
        {shown.map(item => {
            const status = inboxStatus(item.kind)
            const updatedAt = item.requestedAt ?? item.updatedAt
            return <InboxRow key={item.id} item={{ id: item.id, agentId: item.agentId, agentName: item.agentName,
                title: item.title, message: item.summary || null, updatedAt, status }}
                display={{ markRead: t('threadHistory.markRead'), status: t(`threadHistory.status.${status}`, { agent: item.agentName }),
                    time: Number.isFinite(Date.parse(updatedAt)) ? shortRelativeTime(updatedAt, locale) : '' }}
                onOpen={() => { void open(item) }} onMarkRead={() => { if (current(item)) inbox.markRead(item) }} />
        })}
        {!inline && inbox.status === 'loading' && <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">{t('threadHistory.pendingLoading')}</p>}
        {(unavailable || inbox.readError || notice) && <div role="status" className="space-y-2 p-3 text-xs text-muted-foreground">
            <p>{t(notice ? `threadHistory.${notice}` : inbox.readError ? 'threadHistory.markReadFailed' : 'threadHistory.pendingFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => { setNotice(null); inbox.retry() }}>{t('threadHistory.retry')}</Button>
        </div>}
        {!inline && inbox.status === 'ready' && !unavailable && shown.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t(query.trim() ? 'threadHistory.noMatches' : 'emptyNeeds')}</p>}
        <ConfirmDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null) }} title={t('threadHistory.markAllRead.title')}
            description={t('threadHistory.markAllRead.description', { count: confirm?.length ?? 0 })}
            confirmLabel={t('threadHistory.markAllRead.confirm')} cancelLabel={t('cancel')} confirmVariant="default" onConfirm={() => {
                if (confirm && live.current.mounted && live.current.agentId === agentId && !isDesktopQuitting()) inbox.markAllRead(confirm)
                setConfirm(null)
            }} />
    </>
}
