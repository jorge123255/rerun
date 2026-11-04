'use client'

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChromePill } from '@rerun/ui/chrome'
import { AttentionBuddy, ATTENTION_STATUS_META } from '@rerun/ui/inbox'
import { EmptyState } from '@rerun/ui/primitives'
import { shortRelativeTime } from '@rerun/ui/time'
import { DISABLED_AGENT_LABEL } from '@rerun/ui/iso-grid'
import { Button } from '@/components/ui/button'
import type { DesktopAttentionItem } from '@/lib/desktop/attention'
import type { DesktopCompletionItem } from '@/lib/desktop/completed-actions'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { AlertCircleIcon, BellIcon, CheckCheckIcon, InboxIcon, Loader2Icon, RefreshCcwIcon, TriangleAlertIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopAttention, type DesktopAttentionRead } from './useDesktopAttention'
import { useDesktopCompletions } from './useDesktopCompletions'

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
    /**
     * The conversation currently on screen (root-supplied): a finished run in it is acknowledged
     * as it lands, matching the original read-on-visible-conversation semantics.
     */
    visibleSessionId?: string | null
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

// A finished-run row mirrors the original inbox's Done row: emerald dot and buddy, the final-answer
// summary (or the scheduled task's name), « finished its run », a ×count when several runs are
// folded, and an explicit Mark-as-read button. Marking covers exactly the displayed completion IDs.
function DoneRow({ item, onOpen, onMarkRead }: { item: DesktopCompletionItem; onOpen: (item: DesktopCompletionItem) => void; onMarkRead: (item: DesktopCompletionItem) => void }) {
    const meta = ATTENTION_STATUS_META.done
    const activate = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(item)
    }
    return (
        <div
            role="button"
            tabIndex={0}
            data-actions-inbox-done={item.id}
            onClick={() => onOpen(item)}
            onKeyDown={activate}
            className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full bg-current', meta.color)} />
            <AttentionBuddy agentId={item.agentId} status="done" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-2">
                    <span title={item.message ?? undefined} className="truncate text-sm font-medium text-foreground">{item.message ?? item.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{shortRelativeTime(item.completedAt)}</span>
                </div>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{item.message ? `${item.agentName} · ${item.title}` : `${item.agentName} finished its run`}</span>
                    {item.agentEnabled === false && (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{DISABLED_AGENT_LABEL}</span>
                    )}
                    {item.count > 1 && <span className="shrink-0 tabular-nums">×{item.count}</span>}
                </span>
            </div>
            <span
                role="presentation"
                onClick={event => event.stopPropagation()}
                onKeyDown={event => event.stopPropagation()}
            >
                <Button size="icon-sm" variant="ghost" aria-label="Mark as read" title="Mark as read" onClick={() => onMarkRead(item)}>
                    <CheckCheckIcon className="size-3.5" />
                </Button>
            </span>
        </div>
    )
}

function PillContent({ status, items, doneCount, unavailable, failed, open, hasMore }: { status: DesktopAttentionRead; items: DesktopAttentionItem[]; doneCount: number; unavailable: boolean; failed: boolean; open: boolean; hasMore: boolean }) {
    const count = items.length
    if (status === 'loading' && count === 0 && doneCount === 0) {
        return (
            <>
                {open ? <Loader2Icon className="size-4 animate-spin" /> : <BellIcon className="size-4" />}
                <span className="text-muted-foreground">{open ? 'Checking…' : 'Pending'}</span>
            </>
        )
    }
    // A total failure or partial read with nothing confirmed cannot claim an empty workspace; the
    // done count, when a ready read already knows it, still shows next to the alert.
    if ((failed || unavailable) && count === 0 && doneCount === 0) {
        return (
            <>
                <TriangleAlertIcon className="size-4 text-red-400" />
                <span className="text-red-400">{failed ? 'Unavailable' : 'Partial'}</span>
            </>
        )
    }
    const parts: ReactNode[] = []
    if (count > 0) {
        parts.push(
            <span key="pending" className="flex items-center gap-1">
                <span className="relative flex">
                    <BellIcon className="size-4" />
                    <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-500 ring-2 ring-card" />
                </span>
                <span className="font-semibold tabular-nums">{count}</span>
                <span>pending</span>
            </span>
        )
    }
    if (doneCount > 0) {
        parts.push(
            <span key="done" className="flex items-center gap-1 text-emerald-500">
                <span className="font-semibold tabular-nums">{doneCount}</span>
                <span>done</span>
            </span>
        )
    }
    if (parts.length > 0) {
        return (
            <>
                {parts.map((part, index) => (
                    <Fragment key={index}>
                        {index > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
                        {part}
                    </Fragment>
                ))}
            </>
        )
    }
    return (
        <>
            <BellIcon className="size-4" />
            <span className="text-muted-foreground">{hasMore ? 'More activity' : 'No pending'}</span>
        </>
    )
}

/**
 * The Actions inbox for the Mac app: pending questions and action approvals projected from the
 * shared read-only `/api/desktop/attention` endpoint, plus finished runs from the desktop
 * completion store (`/api/desktop/completions`). It reuses the original inbox rows, labels and
 * empty state. Opening a row only navigates to the coworker/session where the existing chat cards
 * answer, approve or decline; a Done row is additionally acknowledged with the exact completion
 * IDs it displayed.
 */
export function DesktopActionsInbox({ agents, onOpenConversation, visibleSessionId, open: openProp, onOpenChange, className }: DesktopActionsInboxProps) {
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
    // Finished runs: a separate bounded read that marks itself read through the explicit mutation.
    // Root's visible conversation applies the original read-on-visible semantics.
    const completions = useDesktopCompletions(open, agents?.map(agent => agent.id), visibleSessionId)
    const doneItems = useMemo(() => completions.items.flatMap(item => {
        if (!roster) return [item]
        const agent = roster.get(item.agentId)
        return agent ? [{ ...item, agentName: agent.name, agentEnabled: agent.enabled !== false }] : []
    }), [completions.items, roster])
    const doneUnavailable = completions.unavailableAgentIds.filter(id => !roster || roster.has(id))
    const doneFailed = completions.status === 'failed'
    const lifecycle = JSON.stringify([open, agents?.map(agent => agent.id).sort() ?? null, visibleSessionId ?? null])
    const lifetime = useRef({ lifecycle, generation: 0, mounted: true })
    if (lifetime.current.lifecycle !== lifecycle) lifetime.current = { lifecycle, generation: lifetime.current.generation + 1, mounted: true }
    const generation = lifetime.current.generation
    useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false } }, [])
    const latest = useRef({ items, doneItems, onOpenConversation })
    latest.current = { items, doneItems, onOpenConversation }
    const rootRef = useRef<HTMLDivElement>(null)
    const pillRef = useRef<HTMLButtonElement>(null)
    const cardId = useId()
    const sorted = useMemo(() => [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [items])
    const partial = unavailableAgentIds.length > 0

    const openItem = useCallback(
        (item: DesktopAttentionItem) => {
            if (!open || !lifetime.current.mounted || lifetime.current.generation !== generation) return
            const current = latest.current.items.find(row => row.id === item.id && row.agentId === item.agentId && row.sessionId === item.sessionId)
            if (!current) return
            // Navigation only. Retained handlers cannot revive a deleted owner or old request.
            change(false)
            latest.current.onOpenConversation?.({ id: current.sessionId, agentId: current.agentId, agentName: current.agentName, title: current.title })
        },
        [change, generation, open]
    )

    const openDone = useCallback(
        (item: DesktopCompletionItem) => {
            if (!open || !lifetime.current.mounted || lifetime.current.generation !== generation) return
            const current = latest.current.doneItems.find(row => row.id === item.id && row.agentId === item.agentId && row.sessionId === item.sessionId)
            if (!current) return
            // Navigation only: no sending, no approving, no executing. The row is acknowledged with
            // the exact displayed completion IDs, like the original openItem→markSeen.
            completions.markRead(item)
            change(false)
            latest.current.onOpenConversation?.({ id: current.sessionId, agentId: current.agentId, agentName: current.agentName, title: current.title })
        },
        [change, completions.markRead, generation, open]
    )

    // Mark-all covers exactly the done rows currently displayed, never a newer arrival.
    const markAllDone = useCallback(() => {
        completions.markAllRead()
    }, [completions.markAllRead])

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
    const doneCount = doneItems.length
    const checking = status === 'loading' || completions.status === 'loading'
    const anyFailed = failed || doneFailed || completions.readError
    const anyPartial = partial || doneUnavailable.length > 0
    const hasMore = !!completions.nextCursor || completions.windowFull
    const pillLabel =
        anyFailed && items.length === 0 && doneCount === 0 ? 'Actions: unavailable'
        : checking && items.length === 0 && doneCount === 0 ? 'Actions: checking'
        : anyPartial && items.length === 0 && doneCount === 0 ? 'Actions: partial — some coworkers unavailable'
        : items.length > 0 ? `Actions: ${items.length} pending${doneCount > 0 ? ` · ${doneCount} done` : ''}`
        : doneCount > 0 ? `Actions: ${doneCount} done`
        : hasMore ? 'Actions: more activity'
        : 'Actions: no pending'

    return (
        <div ref={rootRef} className={cn('relative flex flex-col items-start', className)}>
            {open && (
                <div id={cardId} role="region" aria-label="Actions inbox" className="mb-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-4 pt-3 pb-2">
                        <div className="flex items-baseline gap-2">
                            <h2 className="text-base font-semibold text-foreground">Actions</h2>
                            {status === 'ready' && items.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{items.length} pending</span>}
                            {doneCount > 0 && <span className="text-xs text-emerald-500 tabular-nums">· {doneCount} done</span>}
                        </div>
                        <div className="flex items-center gap-1">
                            {doneCount > 0 && (
                                <Button size="icon-sm" variant="ghost" aria-label="Mark all as read" title="Mark all as read" onClick={markAllDone}>
                                    <CheckCheckIcon className="size-4" />
                                </Button>
                            )}
                            <Button size="icon-sm" variant="ghost" aria-label="Close actions inbox" onClick={closeToPill}>
                                <XIcon className="size-4" />
                            </Button>
                        </div>
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
                    {doneUnavailable.length > 0 && (
                        <div role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-400">
                            <TriangleAlertIcon className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">Some coworkers couldn't be reached, so the finished-runs list may be missing theirs.</span>
                            <Button size="sm" variant="outline" onClick={completions.retry}>
                                <RefreshCcwIcon className="size-3.5" /> Retry
                            </Button>
                        </div>
                    )}
                    {doneFailed && (
                        <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <AlertCircleIcon className="size-3.5 shrink-0 text-red-400" />
                            <span className="min-w-0 flex-1 truncate">Couldn't refresh finished runs.</span>
                            <Button size="sm" variant="outline" onClick={completions.retry}>
                                <RefreshCcwIcon className="size-3.5" /> Retry
                            </Button>
                        </div>
                    )}
                    {completions.readError && (
                        <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <span className="min-w-0 flex-1">Couldn't mark finished runs as read. They are still here.</span>
                            <Button size="sm" variant="outline" onClick={completions.retry}><RefreshCcwIcon className="size-3.5" /> Retry</Button>
                        </div>
                    )}

                    <div className="max-h-[min(22rem,50dvh)] overflow-y-auto overscroll-contain px-2 py-2">
                        {checking && items.length === 0 && doneItems.length === 0 ? (
                            <div role="status" className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                                <Loader2Icon className="size-4 animate-spin" /> Checking for pending actions…
                            </div>
                        ) : failed && items.length === 0 && doneItems.length === 0 ? (
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
                        ) : partial && items.length === 0 && doneItems.length === 0 ? (
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
                        ) : items.length === 0 && doneItems.length === 0 && !doneFailed && !anyPartial && !hasMore && !completions.loadingMore ? (
                            <EmptyState icon={InboxIcon} title="Nothing to handle" description="When a coworker needs you or finishes a run, it lands here." className="py-8" />
                        ) : (
                            <>
                                {items.length > 0 && (
                                    <section aria-label="Needs you">
                                        <h3 className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Needs you</h3>
                                        {sorted.map(item => (
                                            <ActionRow key={item.id} item={item} onOpen={openItem} />
                                        ))}
                                    </section>
                                )}
                                {doneItems.length > 0 && (
                                    <section aria-label="Done" className={cn(items.length > 0 && 'mt-1 border-t border-border pt-1')}>
                                        <h3 className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Done</h3>
                                        {doneItems.map(item => (
                                            <DoneRow key={item.id} item={item} onOpen={openDone} onMarkRead={completions.markRead} />
                                        ))}
                                    </section>
                                )}
                            </>
                        )}
                        {(completions.nextCursor || completions.loadingMore) && !completions.windowFull && (
                            <div className="px-2 py-2">
                                <Button size="sm" variant="outline" disabled={completions.loadingMore} onClick={completions.loadMore}>
                                    {completions.loadingMore ? <><Loader2Icon className="size-3.5 animate-spin" /> Loading older runs…</> : 'Load older runs'}
                                </Button>
                            </div>
                        )}
                        {completions.windowFull && (
                            <div role="status" className="space-y-2 px-2 py-2 text-xs text-muted-foreground">
                                <p>This view has reached its limit. More unread runs remain saved.</p>
                                <Button size="sm" variant="outline" onClick={completions.retry}>Refresh finished runs</Button>
                            </div>
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
                <PillContent status={checking ? 'loading' : status} items={items} doneCount={doneCount} unavailable={anyPartial} failed={anyFailed} open={open} hasMore={hasMore} />
            </ChromePill>
        </div>
    )
}
