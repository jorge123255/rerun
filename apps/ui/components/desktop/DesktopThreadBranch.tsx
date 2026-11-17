'use client'

import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react'
import { useDesktopLocale } from './DesktopLocale'
import { Badge, Stripes } from '@rerun/ui/primitives'
import { AnimatedSize } from '@rerun/ui/steps'
import { usePeekTranslations } from '@/components/notifications/peek-translations'
import { Button } from '@/components/ui/button'
import { ArrowRight, ChevronRightIcon, CalendarClock, WebhookIcon } from '@/lib/icons'
import { threadOpener } from '@/lib/desktop/general-threads'
import { DESKTOP_PEEK_KINDS } from '@/lib/desktop/pending-peek'
import type { DesktopSessionView } from './DesktopApp'
import { DesktopPeekBody } from './DesktopPeekBody'
import { useDesktopInboxPeek, useDesktopPeekAnswer } from './useDesktopInboxPeek'
import { StateDot } from '@/components/agent/sheet/OpenChatsTabStrip'
import { shortRelativeTime } from '@rerun/i18n/format'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { cn } from '@/lib/utils'

const THREAD_STRIPES_INK = 'color-mix(in oklab, var(--foreground) 6%, transparent)'

type ThreadState = 'live' | 'needs' | 'error' | 'done'

const BRANCH_TONE: Record<ThreadState, string> = {
    live: 'border-brand/70',
    needs: 'border-orange-400/70',
    error: 'border-red-400/70',
    done: 'border-border',
}

const ROW = 'group relative flex h-8 items-center gap-2 overflow-hidden px-2.5 text-left text-sm [&>:not(:first-child)]:relative'

const EXPANDED_MAX_WIDTH = 560
// The row's indent under the bubble, `pl-7`.
const BRANCH_INDENT = 28
// Stands for the request of a row that waits, until it is read.
const REQUEST_UNREAD = ''

// Upstream ThreadBranch: one curve for the whole morph. The width, the height and the content move
// together, both ways. Closing, the width waits a beat so the card folds before it narrows to a row.
const EASE = [0.32, 0.72, 0, 1] as const
const GROW: Transition = { duration: 0.34, ease: EASE }
const SHRINK_WIDTH: Transition = { duration: 0.28, ease: EASE, delay: 0.08 }
const BODY_IN: Transition = { height: GROW, opacity: { duration: 0.22, ease: 'easeOut' } }
const BODY_OUT: Transition = { height: { duration: 0.28, ease: EASE }, opacity: { duration: 0.16, ease: 'easeIn' } }
const INSTANT: Transition = { duration: 0 }

/**
 * Whose threads General is showing, and which of them wait on the person and for what (upstream
 * #334's `ThreadPeekOwner`). Given by the coworker's chat; without it a row only opens its thread,
 * as the Chief of Staff's rows do.
 */
export type DesktopThreadPeeks = {
    agentId: string
    agentName: string
    agentEnabled: boolean
    /** By conversation: the kind of request it waits on, and that request's identity. */
    waiting: ReadonlyMap<string, { kind: string; id: string }>
}
export const DesktopThreadPeeksContext = createContext<DesktopThreadPeeks | null>(null)

/**
 * A thread in General: the message it opened with and, under it, the thread's row. A click opens
 * the thread. A row that waits on a question or an approval grows into that request instead
 * (upstream #334, #342), see `ThreadPeek`; any other row that needs the person opens as before.
 */
export function DesktopThreadBranch({ thread, needsYou, onOpen }: { thread: DesktopSessionView; needsYou?: boolean; onOpen: () => void }) {
    const { t } = useDesktopLocale()
    const peeks = useContext(DesktopThreadPeeksContext)
    const opener = threadOpener(thread, thread.originAgentName ?? null, t)
    const state: ThreadState = thread.runStatus === 'running' ? 'live' : thread.runStatus === 'error' ? 'error' : needsYou ? 'needs' : 'done'
    const title = thread.automationName && thread.automationName !== thread.title ? thread.automationName : undefined
    const request = peeks && peeks.agentId === thread.agentId ? peeks.waiting.get(thread.id) : undefined
    const peekable = !!request && DESKTOP_PEEK_KINDS.has(request.kind)
    // Only a row that waits on an answer, or did, carries the card: the others stay a plain button.
    // Never taken back, so the receipt is not cut by a remount.
    const [peeked, setPeeked] = useState(peekable)
    if (peekable && !peeked) setPeeked(true)
    return (
        <div className="flex w-full flex-col gap-2" data-thread-row={thread.id} data-testid="desktop-thread-branch">
            <div className={cn('w-fit max-w-full rounded-2xl rounded-bl-md bg-muted px-3 py-1.5 text-xs text-foreground/80', opener.generic && 'text-muted-foreground italic')}>
                <span className="line-clamp-2 pr-0.5 break-words">{opener.text}</span>
            </div>
            {peeks && peeked ? (
                <ThreadPeek thread={thread} state={state} peekable={peekable} revision={request?.id} owner={peeks} title={title} onOpen={onOpen} />
            ) : (
                <div className="relative w-full pl-7">
                    <BranchCurve state={state} />
                    <button type="button" onClick={onOpen} title={title} className={cn(ROW, 'max-w-full rounded-lg border border-border transition-colors hover:border-foreground/20')}>
                        <RowStripes />
                        <ThreadRowContent thread={thread} state={state} badged open={false} />
                    </button>
                </div>
            )}
        </div>
    )
}

/**
 * The row and the request it waits on, as one element: the row stays on top as its header. A click
 * on a row that waits on an answer unfolds the request under it, the row folds it back, the footer
 * goes to the conversation. Once answered, the receipt shows for a moment, then it folds back to a
 * row without its badge. The request is read as soon as the row waits, so the click unfolds it in
 * one movement.
 */
function ThreadPeek({ thread, state, peekable, revision, owner, title, onOpen }: { thread: DesktopSessionView; state: ThreadState; peekable: boolean; revision: string | undefined; owner: DesktopThreadPeeks; title: string | undefined; onOpen: () => void }) {
    const t = usePeekTranslations()
    const reducedMotion = useReducedMotion()
    const [expanded, setExpanded] = useState(false)
    // The request changes when it is answered too: read again only once the answer and its receipt
    // are over, so neither loses the request it is about.
    const [readAt, setReadAt] = useState(revision)
    const { peek, answer } = useDesktopInboxPeek(thread.id, peekable, readAt)
    const fold = useCallback(() => setExpanded(false), [])
    // The body that folds away keeps the receipt it was showing: the row is ready for the next request at once.
    const { phase, notice, attempt, submit, rearm } = useDesktopPeekAnswer(peek, answer, rearmAfterReceipt => {
        fold()
        rearmAfterReceipt()
    })
    const [measureColumn, columnWidth] = useMeasuredWidth()
    const [measureRow, rowWidth] = useMeasuredWidth()
    const sent = phase.step === 'sent'
    const sending = phase.step === 'sending'
    const pending = peek.state === 'ready' ? peek.peek.pending : null
    if (!sending && !sent && revision !== undefined && readAt !== revision) setReadAt(revision)

    // The row outlives its requests: the one it waits on now, null once it waits on none. What was
    // left of the previous one (a card left open, an answer that came too late) goes with it, so the
    // next request starts folded on a fresh form. An answer on its way keeps its card: the receipt folds it.
    const request = peekable ? (pending?.toolCallId ?? REQUEST_UNREAD) : null
    const [shownRequest, setShownRequest] = useState(request)
    if (shownRequest !== request) {
        setShownRequest(request)
        if (!sending && !sent) {
            if (shownRequest === null || request === null) setExpanded(false)
            rearm()
        }
    }

    // The list may say the coworker no longer waits before the answer's own receipt is over.
    const open = expanded && (peekable || sending || sent)
    // The column's width, minus the branch's indent: what the card takes once open, and the most a
    // row takes. Two px of border around the row's own width.
    const room = columnWidth === null ? null : columnWidth - BRANCH_INDENT
    const collapsedWidth = rowWidth === null ? null : Math.min(rowWidth + 2, room ?? Infinity)
    const openWidth = room === null ? null : Math.min(EXPANDED_MAX_WIDTH, room)
    const width = open ? openWidth : collapsedWidth

    const toggle = () => (peekable || open ? setExpanded(!open) : onOpen())
    const openConversation = () => {
        fold()
        onOpen()
    }

    return (
        <div ref={measureColumn} className="relative w-full pl-7">
            <BranchCurve state={sent ? 'done' : state} />
            <motion.div initial={false} animate={width === null ? undefined : { width }} transition={reducedMotion ? INSTANT : open ? GROW : SHRINK_WIDTH} className={cn('relative w-fit max-w-full overflow-hidden rounded-lg border transition-[background-color,border-color,box-shadow] duration-300', open ? 'border-foreground/15 bg-card shadow-sm' : 'border-border hover:border-foreground/20')}>
                {/* The row as it sits collapsed, on one line and never seen: its width is the one the element folds back to. */}
                <div ref={measureRow} aria-hidden className={cn(ROW, 'invisible absolute top-0 left-0 w-max whitespace-nowrap')}>
                    <ThreadRowContent thread={thread} state={state} badged={!sent} open={false} stretch />
                </div>
                <button type="button" aria-expanded={peekable ? open : undefined} onClick={toggle} title={title} className={cn(ROW, 'w-full')}>
                    <RowStripes />
                    <ThreadRowContent thread={thread} state={state} badged={!sent} open={open} stretch />
                </button>

                <AnimatePresence initial={false}>
                    {open && (
                        <motion.div key="request" data-thread-peek={thread.id} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1, transition: reducedMotion ? INSTANT : BODY_IN }} exit={{ height: 0, opacity: 0, transition: reducedMotion ? INSTANT : BODY_OUT }} className="overflow-hidden">
                            {/* Laid out at its final width from the first frame: the frame reveals it as it widens, the text never reflows mid-morph. */}
                            <div style={{ width: openWidth === null ? undefined : openWidth - 2 }}>
                                <AnimatedSize transition={reducedMotion ? INSTANT : GROW}>
                                    <DesktopPeekBody peek={peek} waiting={peekable} phase={phase} notice={notice} attempt={attempt} agentId={owner.agentId} agentName={owner.agentName}
                                        disabled={!owner.agentEnabled} className="flex flex-col gap-3 border-t border-border p-3" onSubmit={submit} onDismiss={fold} />
                                </AnimatedSize>
                                <div className="flex justify-end border-t border-border px-2 py-1.5">
                                    <Button size="sm" variant="ghost" onClick={openConversation}>
                                        {t('openConversation')}
                                        <ArrowRight className="size-3.5" />
                                    </Button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    )
}

// Widths are animated in pixels: `auto` and `fit-content` cannot be interpolated, and motion's `layout`
// scales the content while it runs, which stretches the row's text.
function useMeasuredWidth(): [(element: HTMLDivElement | null) => void, number | null] {
    const [element, setElement] = useState<HTMLDivElement | null>(null)
    const [value, setValue] = useState<number | null>(null)
    useLayoutEffect(() => {
        if (!element) return
        const measure = () => setValue(element.offsetWidth)
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        measure()
        return () => observer.disconnect()
    }, [element])
    return [setElement, value]
}

function BranchCurve({ state }: { state: ThreadState }) {
    return <span aria-hidden className={cn('absolute -top-2 left-3.5 h-6 w-3 rounded-bl-md border-b border-l transition-colors duration-500', BRANCH_TONE[state])} />
}

// Turned half a turn, the hatch keeps its slant and fades toward the title instead of the chevron.
function RowStripes() {
    return <Stripes fade="right" color={THREAD_STRIPES_INK} band={4} period={8} className="rotate-180 opacity-60 transition-opacity group-hover:opacity-100" />
}

// `stretch` pushes the time and the chevron to the right edge of a row that widens into a card.
function ThreadRowContent({ thread, state, badged, open, stretch = false }: { thread: DesktopSessionView; state: ThreadState; badged: boolean; open: boolean; stretch?: boolean }) {
    const { language, t } = useDesktopLocale()
    const automated = thread.source === 'schedule' || thread.source === 'trigger'
    const SourceIcon = thread.source === 'trigger' ? WebhookIcon : CalendarClock
    const when = Number.isFinite(Date.parse(thread.createdAt)) ? shortRelativeTime(thread.createdAt, desktopLocaleTag(language.locale)) : ''
    return (
        <>
            {state === 'live' && <span role="img" aria-label={t('running')}><StateDot state="live" /></span>}
            {automated && <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className={cn('min-w-0 truncate font-medium', stretch && 'flex-1',
                automated && (state === 'error' ? 'text-destructive' : thread.automationOutcome === 'nothing' && 'text-muted-foreground'))}>{thread.title}</span>
            {badged && (state === 'needs' || state === 'error') && <Badge size="xs" tone={state === 'needs' ? 'orange' : 'red'} glow={false} className="shrink-0">{t(state)}</Badge>}
            {when && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{when}</span>}
            <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-300', open ? 'rotate-90' : 'group-hover:translate-x-0.5')} />
        </>
    )
}
