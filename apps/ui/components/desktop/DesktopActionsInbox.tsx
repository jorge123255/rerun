'use client'

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChromePill } from '@rerun/ui/chrome'
import { AttentionBuddy, ATTENTION_STATUS_META } from '@rerun/ui/inbox'
import { EmptyState } from '@rerun/ui/primitives'
import { shortRelativeTime } from '@rerun/i18n/format'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import type { DesktopCompletionItem } from '@/lib/desktop/completed-actions'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import type { DesktopPendingInboxItem } from '@/lib/desktop/pending-inbox'
import { desktopInboxBadge } from '@/lib/desktop/notification-bridge'
import { AlertCircleIcon, BellIcon, CheckCheckIcon, InboxIcon, Loader2Icon, RefreshCcwIcon, TriangleAlertIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopCompletions, type DesktopCompletionsController } from './useDesktopCompletions'
import { useDesktopNotificationPrefs } from '@/lib/desktop/use-notification-prefs'
import { DesktopInboxRowMenu } from './DesktopInboxRowMenu'
import { useDesktopPendingInbox, type DesktopPendingInboxRead } from './useDesktopPendingInbox'

// The original inbox folds question and approval under one « Needs you » heading, keyed on the
// status metadata labels Question (cyan) and Approval (yellow).
const KIND_STATUS: Record<DesktopPendingInboxItem['kind'], string> = {
    question: 'awaiting_question',
    approval: 'awaiting_approval',
    takeover: 'waiting_human',
    service: 'waiting_human',
    secret: 'waiting_human',
    mcp: 'waiting_human',
    'tool-install': 'awaiting_approval',
    info: 'awaiting_ack',
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
    workspaceId?: number | null
    launchNonce?: string
    hidden?: boolean
    onOpenNotificationSettings?: (agentId: string) => void
    /** Controlled open state. Without it the inbox manages its own fold. */
    open?: boolean
    onOpenChange?: (open: boolean) => void
    /** Position the whole widget; the card rises above the pill. */
    className?: string
}

// The row mirrors @rerun/ui/inbox InboxRow with its hover-revealed Mark-as-read button:
// marking read is an explicit, per-request acknowledgment that never answers, approves or opens.
function ActionRow({ item, onOpen, onMarkRead, menu }: { menu?: ReactNode; item: DesktopPendingInboxItem; onOpen: (item: DesktopPendingInboxItem) => void; onMarkRead: (item: DesktopPendingInboxItem) => void }) {
    const { language, t } = useDesktopLocale()
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
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{shortRelativeTime(item.requestedAt ?? item.updatedAt, desktopLocaleTag(language.locale))}</span>
                </div>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{item.summary ? `${item.agentName} · ${item.title}` : t(`actions.sentences.${item.kind}`, { agent: item.agentName })}</span>
                    {item.agentEnabled === false && (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{t('actions.inactive')}</span>
                    )}
                </span>
            </div>
            <span
                role="presentation"
                onClick={event => event.stopPropagation()}
                onKeyDown={event => event.stopPropagation()}
            >
                <Button size="icon-sm" variant="ghost" aria-label={t('actions.markRead')} title={t('actions.markRead')} onClick={() => onMarkRead(item)}>
                    <CheckCheckIcon className="size-3.5" />
                </Button>
            </span>
            {menu}
        </div>
    )
}

// A finished-run row mirrors the original inbox's Done row: emerald dot and buddy, the final-answer
// summary (or the scheduled task's name), « finished its run », a ×count when several runs are
// folded, and an explicit Mark-as-read button. Marking covers exactly the displayed completion IDs.
function DoneRow({ item, onOpen, onMarkRead, menu }: { menu?: ReactNode; item: DesktopCompletionItem; onOpen: (item: DesktopCompletionItem) => void; onMarkRead: (item: DesktopCompletionItem) => void }) {
    const { language, t } = useDesktopLocale()
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
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{shortRelativeTime(item.completedAt, desktopLocaleTag(language.locale))}</span>
                </div>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{item.message ? `${item.agentName} · ${item.title}` : t('actions.sentences.done', { agent: item.agentName })}</span>
                    {item.agentEnabled === false && (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{t('actions.inactive')}</span>
                    )}
                    {item.count > 1 && <span className="shrink-0 tabular-nums">×{item.count}</span>}
                </span>
            </div>
            <span
                role="presentation"
                onClick={event => event.stopPropagation()}
                onKeyDown={event => event.stopPropagation()}
            >
                <Button size="icon-sm" variant="ghost" aria-label={t('actions.markRead')} title={t('actions.markRead')} onClick={() => onMarkRead(item)}>
                    <CheckCheckIcon className="size-3.5" />
                </Button>
            </span>
            {menu}
        </div>
    )
}

function PillContent({ status, items, doneCount, unavailable, failed, open, hasMore }: { status: DesktopPendingInboxRead; items: DesktopPendingInboxItem[]; doneCount: number; unavailable: boolean; failed: boolean; open: boolean; hasMore: boolean }) {
    const { t } = useDesktopLocale()
    const count = items.length
    if (status === 'loading' && count === 0 && doneCount === 0) {
        return (
            <>
                {open ? <Loader2Icon className="size-4 animate-spin" /> : <BellIcon className="size-4" />}
                <span className="text-muted-foreground @max-4xl/board:hidden">{open ? t('actions.checking') : t('actions.pending')}</span>
            </>
        )
    }
    // A total failure or partial read with nothing confirmed cannot claim an empty workspace; the
    // done count, when a ready read already knows it, still shows next to the alert.
    if ((failed || unavailable) && count === 0 && doneCount === 0) {
        return (
            <>
                <TriangleAlertIcon className="size-4 text-red-400" />
                <span className="text-red-400 @max-4xl/board:hidden">{failed ? t('actions.unavailable') : t('actions.partial')}</span>
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
                <span className="tabular-nums @max-4xl/board:hidden">{t('actions.pendingCount', { count })}</span>
            </span>
        )
    }
    if (doneCount > 0) {
        parts.push(
            <span key="done" className="flex items-center gap-1 text-emerald-500 @max-4xl/board:hidden">
                <span className="tabular-nums">{t('actions.doneCount', { count: doneCount })}</span>
            </span>
        )
    }
    if (parts.length > 0) {
        return (
            <>
                {count === 0 && <BellIcon className="hidden size-4 text-emerald-500 @max-4xl/board:block" />}
                {parts.map((part, index) => (
                    <Fragment key={index}>
                        {index > 0 && <span aria-hidden className="text-muted-foreground @max-4xl/board:hidden">·</span>}
                        {part}
                    </Fragment>
                ))}
            </>
        )
    }
    return (
        <>
            <BellIcon className="size-4" />
            <span className="text-muted-foreground @max-4xl/board:hidden">{hasMore ? t('actions.more') : t('actions.empty')}</span>
        </>
    )
}

/**
 * The Actions inbox for the Mac app: pending questions and action approvals from the desktop
 * pending inbox (`/api/desktop/pending-inbox`, the shared attention projection minus the inbox's
 * own read receipts), plus finished runs from the desktop completion store
 * (`/api/desktop/completions`). It reuses the original inbox rows, labels and empty state. Opening
 * a row only navigates to the coworker/session where the existing chat cards answer, approve or
 * decline; marking pending read is explicit and never answers; a Done row is additionally
 * acknowledged with the exact completion IDs it displayed.
 */
export function DesktopActionsInbox(props: DesktopActionsInboxProps & { completions?: DesktopCompletionsController }) {
    return props.completions
        ? <DesktopActionsInboxView {...props} completions={props.completions} />
        : <StandaloneActionsInbox {...props} />
}

function StandaloneActionsInbox(props: DesktopActionsInboxProps) {
    const [internalOpen, setInternalOpen] = useState(false)
    if (props.hidden && internalOpen) setInternalOpen(false)
    const open = !props.hidden && (props.open ?? internalOpen)
    const whileHidden = !!(props.workspaceId && props.launchNonce && desktopInboxBadge())
    const completions = useDesktopCompletions(open, props.agents?.map(agent => agent.id), props.visibleSessionId, true, whileHidden)
    return <DesktopActionsInboxView {...props} open={open} onOpenChange={props.onOpenChange ?? setInternalOpen} completions={completions} />
}

function DesktopActionsInboxView({ agents, onOpenConversation, visibleSessionId, workspaceId, launchNonce, hidden = false, onOpenNotificationSettings, open: openProp, onOpenChange, className, completions }: DesktopActionsInboxProps & { completions: DesktopCompletionsController }) {
    const { language, t } = useDesktopLocale()
    const open = !hidden && !!openProp
    const setInboxBadge = workspaceId && launchNonce ? desktopInboxBadge() : undefined
    const whileHidden = typeof setInboxBadge === 'function'
    const [rowMenuOpen, setRowMenuOpen] = useState(false)
    const { ruleOf, ready: prefsReady, loading: prefsLoading, changeCoworkerRule } = useDesktopNotificationPrefs(open && !!workspaceId && !!onOpenNotificationSettings)
    const change = useCallback((next: boolean) => { onOpenChange?.(next) }, [onOpenChange])
    // Original WorkspaceInbox keeps its collapsed pill current. Observe while visible even when
    // folded; each hook still requires an open panel for an explicit mark-read action.
    const rowMenu = (item: { agentId: string; agentName: string }) => workspaceId && onOpenNotificationSettings
        ? <DesktopInboxRowMenu workspaceId={workspaceId} agentId={item.agentId} agentName={item.agentName}
            rule={ruleOf(item.agentId)} ready={prefsReady && !prefsLoading} changeRule={changeCoworkerRule} onOpenChange={setRowMenuOpen}
            onOpenSettings={() => { change(false); onOpenNotificationSettings(item.agentId) }} />
        : undefined
    const pendingInbox = useDesktopPendingInbox(open, agents?.map(agent => agent.id), true, whileHidden)
    const { status, items: received, unavailableAgentIds: unavailable, retry, readError: pendingReadError, markRead, markAllRead: markPendingAllRead } = pendingInbox
    const roster = useMemo(() => agents ? new Map(agents.map(agent => [agent.id, agent])) : null, [agents])
    const items = useMemo(() => received.flatMap(item => {
        if (!roster) return [item]
        const agent = roster.get(item.agentId)
        return agent ? [{ ...item, agentName: agent.name, agentEnabled: agent.enabled !== false }] : []
    }), [received, roster])
    const unavailableAgentIds = unavailable.filter(id => !roster || roster.has(id))
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
    const sorted = useMemo(() => [...items].sort((a, b) => (b.requestedAt ?? b.updatedAt).localeCompare(a.requestedAt ?? a.updatedAt)), [items])
    const partial = unavailableAgentIds.length > 0

    const openItem = useCallback(
        (item: DesktopPendingInboxItem) => {
            if (!open || isDesktopQuitting() || !lifetime.current.mounted || lifetime.current.generation !== generation) return
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
            if (!open || isDesktopQuitting() || !lifetime.current.mounted || lifetime.current.generation !== generation) return
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

    // Mark-all covers exactly the rows on screen at confirmation opening — the pending item ids
    // and the done completion ids alike — never a newer arrival. Like the original inbox, the
    // whole-list mark asks first, with the original copy.
    const [confirmAllOpen, setConfirmAllOpen] = useState(false)
    const markAllTargets = useRef<{ generation: number; pending: DesktopPendingInboxItem[]; done: DesktopCompletionItem[] } | null>(null)
    const openMarkAllConfirm = useCallback(() => {
        if (!open || isDesktopQuitting() || !lifetime.current.mounted || lifetime.current.generation !== generation) return
        if (items.length + doneItems.length === 0) return
        markAllTargets.current = { generation, pending: items, done: doneItems }
        setConfirmAllOpen(true)
    }, [doneItems, generation, items, open])
    const capturedTargets = markAllTargets.current
    const confirmMarkAll = useCallback(() => {
        const targets = capturedTargets
        if (!open || isDesktopQuitting() || !targets || targets !== markAllTargets.current || targets.generation !== generation || !lifetime.current.mounted || lifetime.current.generation !== generation) return
        markAllTargets.current = null
        setConfirmAllOpen(false)
        markPendingAllRead(targets.pending)
        completions.markAllRead(targets.done.flatMap(item => item.completionIds))
    }, [capturedTargets, completions.markAllRead, generation, markPendingAllRead, open])
    useEffect(() => {
        if (!open || markAllTargets.current?.generation !== generation) {
            markAllTargets.current = null
            setConfirmAllOpen(false)
        }
    }, [open, generation])
    const confirmCount = markAllTargets.current ? markAllTargets.current.pending.length + markAllTargets.current.done.length : 0

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
        if (!open || confirmAllOpen || rowMenuOpen) return
        const onPointerDown = (event: globalThis.PointerEvent) => {
            if (rootRef.current?.contains(event.target as Node)) return
            change(false)
        }
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            // Radix may synchronously dismiss its portal during capture and attach this
            // listener before the same Escape bubbles. Respect its consumed event.
            if (event.key !== 'Escape' || event.defaultPrevented) return
            closeToPill()
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open, confirmAllOpen, rowMenuOpen, change, closeToPill])

    const failed = status === 'failed'
    const doneCount = doneItems.reduce((sum, item) => sum + item.count, 0)
    const checking = status === 'loading' || completions.status === 'loading'
    const anyFailed = failed || doneFailed || completions.readError
    const anyPartial = partial || doneUnavailable.length > 0
    const hasMore = !!completions.nextCursor || completions.windowFull
    const badgeCount = items.length + doneCount
    useEffect(() => {
        // An unavailable read is not evidence that the last unread item went away.
        if (!setInboxBadge || !workspaceId || !launchNonce || checking || (badgeCount === 0 && (anyFailed || anyPartial))) return
        setInboxBadge({ workspaceId, launchNonce, count: badgeCount })
    }, [setInboxBadge, workspaceId, launchNonce, checking, badgeCount, anyFailed, anyPartial])
    const pendingLabel = t('actions.pendingCount', { count: items.length })
    const doneLabel = t('actions.doneCount', { count: doneCount })
    const lower = (label: string) => label.toLocaleLowerCase(desktopLocaleTag(language.locale))
    const summary =
        anyFailed && items.length === 0 && doneCount === 0 ? lower(t('actions.unavailable'))
        : checking && items.length === 0 && doneCount === 0 ? lower(t('actions.checking')).replace(/…$/, '')
        : anyPartial && items.length === 0 && doneCount === 0 ? t('actions.partialSummary')
        : items.length > 0 ? `${pendingLabel}${doneCount > 0 ? ` · ${doneLabel}` : ''}`
        : doneCount > 0 ? doneLabel
        : lower(hasMore ? t('actions.more') : t('actions.empty'))
    const pillLabel = t('actions.pill', { title: t('actions.title'), summary })

    if (hidden) return null
    return (
        <div ref={rootRef} className={cn('relative flex flex-col items-start', className)}>
            {open && (
                <div id={cardId} role="region" aria-label={t('actions.region')} className="absolute bottom-full z-10 mb-2 flex w-[min(24rem,100cqw)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-4 pt-3 pb-2">
                        <div className="flex items-baseline gap-2">
                            <h2 className="text-base font-semibold text-foreground">{t('actions.title')}</h2>
                            {status === 'ready' && items.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{pendingLabel}</span>}
                            {doneCount > 0 && <span className="text-xs text-emerald-500 tabular-nums">· {doneLabel}</span>}
                        </div>
                        <div className="flex items-center gap-1">
                            {(items.length > 0 || doneCount > 0) && (
                                <Button size="icon-sm" variant="ghost" aria-label={t('actions.markAllRead')} title={t('actions.markAllRead')} onClick={openMarkAllConfirm}>
                                    <CheckCheckIcon className="size-4" />
                                </Button>
                            )}
                            <Button size="icon-sm" variant="ghost" aria-label={t('actions.close')} onClick={closeToPill}>
                                <XIcon className="size-4" />
                            </Button>
                        </div>
                    </div>

                    {partial && (
                        <div role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-400">
                            <TriangleAlertIcon className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">{t('actions.missingPending')}</span>
                            <Button size="sm" variant="outline" onClick={retry}>
                                <RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}
                            </Button>
                        </div>
                    )}
                    {failed && (
                        <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <AlertCircleIcon className="size-3.5 shrink-0 text-red-400" />
                            <span className="min-w-0 flex-1 truncate">{t('actions.refreshPendingFailed')}</span>
                            <Button size="sm" variant="outline" onClick={retry}>
                                <RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}
                            </Button>
                        </div>
                    )}
                    {doneUnavailable.length > 0 && (
                        <div role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-400">
                            <TriangleAlertIcon className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">{t('actions.missingDone')}</span>
                            <Button size="sm" variant="outline" onClick={completions.retry}>
                                <RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}
                            </Button>
                        </div>
                    )}
                    {doneFailed && (
                        <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <AlertCircleIcon className="size-3.5 shrink-0 text-red-400" />
                            <span className="min-w-0 flex-1 truncate">{t('actions.refreshDoneFailed')}</span>
                            <Button size="sm" variant="outline" onClick={completions.retry}>
                                <RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}
                            </Button>
                        </div>
                    )}
                    {pendingReadError && (
                        <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <AlertCircleIcon className="size-3.5 shrink-0 text-red-400" />
                            <span className="min-w-0 flex-1">{t('actions.markPendingFailed')}</span>
                            <Button size="sm" variant="outline" onClick={retry}>
                                <RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}
                            </Button>
                        </div>
                    )}
                    {completions.readError && (
                        <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <span className="min-w-0 flex-1">{t('actions.markDoneFailed')}</span>
                            <Button size="sm" variant="outline" onClick={completions.retry}><RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}</Button>
                        </div>
                    )}

                    <div className="max-h-[min(22rem,50dvh)] overflow-y-auto overscroll-contain px-2 py-2">
                        {checking && items.length === 0 && doneItems.length === 0 ? (
                            <div role="status" className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                                <Loader2Icon className="size-4 animate-spin" /> {t('actions.checkingPending')}
                            </div>
                        ) : failed && items.length === 0 && doneItems.length === 0 ? (
                            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                                <AlertCircleIcon className="size-8 text-red-400" />
                                <div className="space-y-1">
                                    <p className="text-sm font-medium text-foreground">{t('actions.noConnection')}</p>
                                    <p className="max-w-[36ch] text-xs text-muted-foreground">{t('actions.noConnectionHelp')}</p>
                                </div>
                                <Button size="sm" variant="outline" onClick={retry}>
                                    <RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}
                                </Button>
                            </div>
                        ) : partial && items.length === 0 && doneItems.length === 0 ? (
                            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                                <TriangleAlertIcon className="size-8 text-red-400" />
                                <div className="space-y-1">
                                    <p className="text-sm font-medium text-foreground">{t('actions.partialTitle')}</p>
                                    <p className="max-w-[36ch] text-xs text-muted-foreground">{t('actions.partialHelp')}</p>
                                </div>
                                <Button size="sm" variant="outline" onClick={retry}>
                                    <RefreshCcwIcon className="size-3.5" /> {t('actions.retry')}
                                </Button>
                            </div>
                        ) : items.length === 0 && doneItems.length === 0 && !doneFailed && !anyPartial && !hasMore && !completions.loadingMore ? (
                            <EmptyState icon={InboxIcon} title={t('actions.emptyTitle')} description={t('actions.emptyDescription')} className="py-8" />
                        ) : (
                            <>
                                {items.length > 0 && (
                                    <section aria-label={t('actions.needsYou')}>
                                        <h3 className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t('actions.needsYou')}</h3>
                                        {sorted.map(item => (
                                            <ActionRow key={item.id} item={item} onOpen={openItem} onMarkRead={markRead} menu={rowMenu(item)} />
                                        ))}
                                    </section>
                                )}
                                {doneItems.length > 0 && (
                                    <section aria-label={t('actions.done')} className={cn(items.length > 0 && 'mt-1 border-t border-border pt-1')}>
                                        <h3 className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t('actions.done')}</h3>
                                        {doneItems.map(item => (
                                            <DoneRow key={item.id} item={item} onOpen={openDone} onMarkRead={completions.markRead} menu={rowMenu(item)} />
                                        ))}
                                    </section>
                                )}
                            </>
                        )}
                        {(completions.nextCursor || completions.loadingMore) && !completions.windowFull && (
                            <div className="px-2 py-2">
                                <Button size="sm" variant="outline" disabled={completions.loadingMore} onClick={completions.loadMore}>
                                    {completions.loadingMore ? <><Loader2Icon className="size-3.5 animate-spin" /> {t('actions.loadingOlder')}</> : t('actions.loadOlder')}
                                </Button>
                            </div>
                        )}
                        {completions.windowFull && (
                            <div role="status" className="space-y-2 px-2 py-2 text-xs text-muted-foreground">
                                <p>{t('actions.limit')}</p>
                                <Button size="sm" variant="outline" onClick={completions.retry}>{t('actions.refreshDone')}</Button>
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
            <ConfirmDialog
                open={confirmAllOpen}
                onOpenChange={next => { if (!next) markAllTargets.current = null; setConfirmAllOpen(next) }}
                title={t('actions.confirmRead')}
                description={t('actions.confirmDescription', { count: confirmCount })}
                confirmLabel={t('actions.markAllRead')}
                cancelLabel={t('cancel')}
                confirmVariant="default"
                onConfirm={() => confirmMarkAll()}
            />
        </div>
    )
}
