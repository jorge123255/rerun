'use client'

import { useEffect, useRef, useState } from 'react'
import { InboxRow } from '@rerun/ui/inbox'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { CheckCheckIcon } from '@/lib/icons'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { DESKTOP_PENDING_INBOX_URL, desktopPendingInboxSchema, type DesktopPendingInboxItem } from '@/lib/desktop/pending-inbox'
import { useDesktopPendingInbox, type DesktopPendingInboxController } from './useDesktopPendingInbox'

// AgentChatsList's Needs you surface, backed by the same durable receipts as the Mac inbox.
// Opening navigates only; Mark as read never supplies an answer or an approval.
export function DesktopNeedsChats({ agentId, query, onSelect, busy = false, inbox: supplied }: {
    agentId: string; query: string; onSelect: (id: string) => void; busy?: boolean; inbox?: DesktopPendingInboxController
}) {
    const local = useDesktopPendingInbox(!supplied, [agentId])
    const inbox = supplied ?? local
    const [notice, setNotice] = useState('')
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
        if (live.current.busy) { setNotice('Wait for the current chat to finish before switching.'); return }
        read.current?.abort()
        const controller = new AbortController()
        const epoch = interaction.current.epoch
        read.current = controller
        setNotice('')
        try {
            const response = await fetch(DESKTOP_PENDING_INBOX_URL, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) })
            if (!response.ok) throw new Error('Unavailable')
            const fresh = desktopPendingInboxSchema.parse(await response.json())
            if (!current(item) || live.current.busy || controller.signal.aborted || read.current !== controller || interaction.current.epoch !== epoch) return
            const target = fresh.items.find(row => matches(row, item))
            if (!target || fresh.unavailableAgentIds.includes(agentId)) { setNotice('This request changed. Refresh the list and choose it again.'); inbox.retry(); return }
            live.current.onSelect(target.sessionId)
        } catch { if (current(item) && !controller.signal.aborted && read.current === controller) setNotice('Could not check this request. Try again.') }
    }
    const shown = inbox.items.filter(item => `${item.title} ${item.summary}`.toLowerCase().includes(query.trim().toLowerCase()))
    const unavailable = inbox.status === 'failed' || inbox.unavailableAgentIds.includes(agentId)
    return <div className="max-h-[420px] min-h-0 space-y-0.5 overflow-y-auto px-2 pb-2">
        {!!inbox.items.length && <div className="flex justify-end">
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => { if (!isDesktopQuitting()) { interaction.current.epoch++; read.current?.abort(); setConfirm([...inbox.items]) } }}><CheckCheckIcon className="size-3.5" />Mark all as read</Button>
        </div>}
        {shown.map(item => <InboxRow key={item.id} item={{ id: item.id, agentId: item.agentId, agentName: item.agentName,
            title: item.title, message: item.summary || null, updatedAt: item.requestedAt ?? item.updatedAt,
            status: item.kind === 'question' ? 'awaiting_question' : 'awaiting_approval' }}
            onOpen={() => { void open(item) }} onMarkRead={() => { if (current(item)) inbox.markRead(item) }} />)}
        {inbox.status === 'loading' && <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">Checking pending requests…</p>}
        {(unavailable || inbox.readError || notice) && <div role="status" className="space-y-2 p-3 text-xs text-muted-foreground">
            <p>{notice || (inbox.readError ? 'Could not mark every request as read.' : 'Pending requests could not be loaded.')}</p>
            <Button size="sm" variant="outline" onClick={() => { setNotice(''); inbox.retry() }}>Retry</Button>
        </div>}
        {inbox.status === 'ready' && !unavailable && shown.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{query.trim() ? 'No matching conversations.' : 'Nothing waits on you.'}</p>}
        <ConfirmDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null) }} title="Mark everything as read?"
            description={`${confirm?.length ?? 0} conversation${confirm?.length === 1 ? '' : 's'} will leave this list. Requests still waiting on an answer are cleared too, without being answered.`}
            confirmLabel="Mark all as read" confirmVariant="default" onConfirm={() => {
                if (confirm && live.current.mounted && live.current.agentId === agentId && !isDesktopQuitting()) inbox.markAllRead(confirm)
                setConfirm(null)
            }} />
    </div>
}
