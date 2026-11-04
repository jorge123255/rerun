'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChromePill } from '@rerun/ui/chrome'
import { AttentionBuddy, ATTENTION_STATUS_META } from '@rerun/ui/inbox'
import { EmptyState } from '@rerun/ui/primitives'
import { shortRelativeTime } from '@rerun/ui/time'
import { DISABLED_AGENT_LABEL } from '@rerun/ui/iso-grid'
import { Button } from '@/components/ui/button'
import type { DesktopAttentionItem } from '@/lib/desktop/attention'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { AlertCircleIcon, BellIcon, InboxIcon, Loader2Icon, RefreshCcwIcon, TriangleAlertIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopAttention, type DesktopAttentionRead } from './useDesktopAttention'

// The original inbox folds question and approval under one « Needs you » heading, keyed on the
// status metadata labels Question (cyan) and Approval (yellow).
const KIND_STATUS: Record<DesktopAttentionItem['kind'], string> = {
    question: 'awaiting_question',
    approval: 'awaiting_approval',
}
const KIND_SENTENCE: Record<DesktopAttentionItem['kind'], string> = {
    question: 'asked you a question',
    approval: 'needs your approval',
}

export type DesktopActionsInboxProps = {
    agents?: readonly Pick<DesktopAgentView, 'id' | 'name' | 'enabled'>[]
    /** Navigation only: opens the exact coworker/session, never answers, approves or marks handled. */
    onOpenConversation?: (hit: DesktopConversationHit) => void
    /** Controlled open state. Without it the inbox manages its own fold. */
    open?: boolean
    onOpenChange?: (open: boolean) => void
    /** Position the whole widget; the card rises above the pill. */
    className?: string
}

// The row mirrors @rerun/ui/inbox InboxRow without its Mark-as-read button: this slice is
// navigation only, so a visible-but-inert button would only suggest an action the inbox must not take.
function ActionRow({ item, onOpen }: { item: DesktopAttentionItem; onOpen: (item: DesktopAttentionItem) => void }) {
    const status = KIND_STATUS[item.kind]
    const meta = ATTENTION_STATUS_META[status]
    const activate = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(item)
    }
    return (
        <div
            role="button"
            tabIndex={0}
            data-actions-inbox-item={item.id}
            onClick={() => onOpen(item)}
            onKeyDown={activate}
            className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full bg-current', meta.color)} />
            <AttentionBuddy agentId={item.agentId} status={status} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-2">
                    <span title={item.summary || undefined} className="truncate text-sm font-medium text-foreground">{item.summary || item.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{shortRelativeTime(item.updatedAt)}</span>
                </div>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{item.summary ? `${item.agentName} · ${item.title}` : `${item.agentName} ${KIND_SENTENCE[item.kind]}`}</span>
                    {item.agentEnabled === false && (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{DISABLED_AGENT_LABEL}</span>
                    )}
                </span>
            </div>
        </div>
    )
}

function PillContent({ status, items, unavailable, failed, open }: { status: DesktopAttentionRead; items: DesktopAttentionItem[]; unavailable: boolean; failed: boolean; open: boolean }) {
    const count = items.length
    if (status === 'loading' && count === 0) {
        return (
            <>
                {open ? <Loader2Icon className="size-4 animate-spin" /> : <BellIcon className="size-4" />}
                <span className="text-muted-foreground">{open ? 'Checking…' : 'Pending'}</span>
            </>
        )
    }
    if (failed && count === 0) {
        return (
            <>
                <TriangleAlertIcon className="size-4 text-red-400" />
                <span className="text-red-400">Unavailable</span>
            </>
        )
    }
    // A partial read with no confirmed items cannot claim an empty workspace: some coworkers are
    // missing, so their pending actions may be missing too.
    if (unavailable && count === 0) {
        return (
            <>
                <TriangleAlertIcon className="size-4 text-red-400" />
                <span className="text-red-400">Partial</span>
            </>
        )
    }
    if (count > 0) {
        return (
            <>
                <span className="relative flex">
                    <BellIcon className="size-4" />
                    <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-500 ring-2 ring-card" />
                </span>
                <span className="font-semibold tabular-nums">{count}</span>
                <span>pending</span>
            </>
        )
    }
    return (
        <>
            <BellIcon className="size-4" />
            <span className="text-muted-foreground">No pending</span>
        </>
    )
}

/**
 * The Actions inbox for the Mac app: pending questions and action approvals projected from the
 * shared read-only `/api/desktop/attention` endpoint, reusing the original inbox rows, labels and
 * empty state. Opening a row only navigates to the coworker/session where the existing chat cards
 * answer, approve or decline.
 */
export function DesktopActionsInbox({ agents, onOpenConversation, open: openProp, onOpenChange, className }: DesktopActionsInboxProps) {
    const [internalOpen, setInternalOpen] = useState(false)
    const open = openProp ?? internalOpen
    const change = useCallback(
        (next: boolean) => {
            if (onOpenChange) onOpenChange(next)
            else setInternalOpen(next)
        },
        [onOpenChange]
    )
    // Polling runs only while the card is open and the window is visible; closing cancels a read in flight.
    const { status, items: received, unavailableAgentIds: unavailable, retry } = useDesktopAttention(open, agents?.map(agent => agent.id))
    const roster = useMemo(() => agents ? new Map(agents.map(agent => [agent.id, agent])) : null, [agents])
    const items = useMemo(() => received.flatMap(item => {
        if (!roster) return [item]
        const agent = roster.get(item.agentId)
        return agent ? [{ ...item, agentName: agent.name, agentEnabled: agent.enabled !== false }] : []
    }), [received, roster])
    const unavailableAgentIds = unavailable.filter(id => !roster || roster.has(id))
    const latest = useRef({ items, onOpenConversation })
    latest.current = { items, onOpenConversation }
    const rootRef = useRef<HTMLDivElement>(null)
    const pillRef = useRef<HTMLButtonElement>(null)
    const cardId = useId()
    const sorted = useMemo(() => [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [items])
    const partial = unavailableAgentIds.length > 0

    const openItem = useCallback(
        (item: DesktopAttentionItem) => {
            const current = latest.current.items.find(row => row.id === item.id && row.agentId === item.agentId && row.sessionId === item.sessionId)
            if (!current) return
            // Navigation only. Retained handlers cannot revive a deleted owner or old request.
            change(false)
            latest.current.onOpenConversation?.({ id: current.sessionId, agentId: current.agentId, agentName: current.agentName, title: current.title })
        },
        [change]
    )

    // Only an explicit Close or Escape folds the card back onto the pill and takes the focus
    // there, like the original InboxSurface. Navigation and an outside pointer-down close the
    // card without stealing focus from whatever the user was interacting with.
    const refocusPill = useRef(false)
    const closeToPill = useCallback(() => {
        refocusPill.current = true
        change(false)
    }, [change])
    useEffect(() => {
        if (open) return
        if (refocusPill.current) pillRef.current?.focus({ preventScroll: true })
        refocusPill.current = false
    }, [open])

    // An outside press or Escape folds the card; the card's own clicks stay its own.
    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: globalThis.PointerEvent) => {
            if (rootRef.current?.contains(event.target as Node)) return
            change(false)
        }
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape') return
            closeToPill()
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open, change, closeToPill])

    const failed = status === 'failed'
    const pillLabel =
        failed && items.length === 0 ? 'Actions: unavailable'
        : status === 'loading' && items.length === 0 ? 'Actions: checking'
        : partial && items.length === 0 ? 'Actions: partial — some coworkers unavailable'
        : items.length > 0 ? `Actions: ${items.length} pending`
        : 'Actions: no pending'

    return (
        <div ref={rootRef} className={cn('relative flex flex-col items-start', className)}>
            {open && (
                <div id={cardId} role="region" aria-label="Actions inbox" className="mb-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-4 pt-3 pb-2">
                        <div className="flex items-baseline gap-2">
                            <h2 className="text-base font-semibold text-foreground">Actions</h2>
                            {status === 'ready' && items.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{items.length} pending</span>}
                        </div>
                        <Button size="icon-sm" variant="ghost" aria-label="Close actions inbox" onClick={closeToPill}>
                            <XIcon className="size-4" />
                        </Button>
                    </div>

                    {partial && (
                        <div role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-400">
                            <TriangleAlertIcon className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">Some coworkers couldn't be reached, so this list may be missing their pending actions.</span>
                            <Button size="sm" variant="outline" onClick={retry}>
                                <RefreshCcwIcon className="size-3.5" /> Retry
                            </Button>
                        </div>
                    )}
                    {failed && (
                        <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <AlertCircleIcon className="size-3.5 shrink-0 text-red-400" />
                            <span className="min-w-0 flex-1 truncate">Couldn't refresh the actions list.</span>
                            <Button size="sm" variant="outline" onClick={retry}>
                                <RefreshCcwIcon className="size-3.5" /> Retry
                            </Button>
                        </div>
                    )}

                    <div className="max-h-[min(22rem,50dvh)] overflow-y-auto overscroll-contain px-2 py-2">
                        {status === 'loading' && items.length === 0 ? (
                            <div role="status" className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                                <Loader2Icon className="size-4 animate-spin" /> Checking for pending actions…
                            </div>
                        ) : failed && items.length === 0 ? (
                            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                                <AlertCircleIcon className="size-8 text-red-400" />
                                <div className="space-y-1">
                                    <p className="text-sm font-medium text-foreground">Can't reach the actions list</p>
                                    <p className="max-w-[36ch] text-xs text-muted-foreground">Retry, or open a coworker's chat directly — pending questions and approvals still live there.</p>
                                </div>
                                <Button size="sm" variant="outline" onClick={retry}>
                                    <RefreshCcwIcon className="size-3.5" /> Retry
                                </Button>
                            </div>
                        ) : partial && items.length === 0 ? (
                            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                                <TriangleAlertIcon className="size-8 text-red-400" />
                                <div className="space-y-1">
                                    <p className="text-sm font-medium text-foreground">Some coworkers couldn't be reached</p>
                                    <p className="max-w-[36ch] text-xs text-muted-foreground">Their pending actions aren't shown. Retry to refresh the list.</p>
                                </div>
                                <Button size="sm" variant="outline" onClick={retry}>
                                    <RefreshCcwIcon className="size-3.5" /> Retry
                                </Button>
                            </div>
                        ) : items.length === 0 ? (
                            <EmptyState icon={InboxIcon} title="Nothing to handle" description="Pending questions and approvals will show up here." className="py-8" />
                        ) : (
                            <section aria-label="Needs you">
                                <h3 className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Needs you</h3>
                                {sorted.map(item => (
                                    <ActionRow key={item.id} item={item} onOpen={openItem} />
                                ))}
                            </section>
                        )}
                    </div>
                </div>
            )}
            <ChromePill
                ref={pillRef}
                start="icon"
                end="icon"
                aria-expanded={open}
                aria-controls={cardId}
                aria-label={pillLabel}
                onClick={() => change(!open)}
            >
                <PillContent status={status} items={items} unavailable={partial} failed={failed} open={open} />
            </ChromePill>
        </div>
    )
}
