'use client'

import { createElement, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Shared motion for the Mac's panels. Everything here is a CSS animation on transform and opacity
// (tw-animate-css, plus the keyframes in app/desktop-panel-motion.css), so nothing waits on it: a
// click lands at once and the text is in the page from the first frame. With "Reduce motion" on,
// `motion-reduce:animate-none` leaves an instant state change.

/** A card or row sliding up into place as it arrives. */
export const DESKTOP_ARRIVE_CLASS = 'animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none'
/** A new row coming in at the top of a list. */
export const DESKTOP_ARRIVE_TOP_CLASS = 'animate-in fade-in-0 slide-in-from-top-2 duration-300 ease-out motion-reduce:animate-none'
/** New content taking the place of what it replaces: a short fade, no movement. */
export const DESKTOP_SETTLE_CLASS = 'animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none'

// What already had its arrival, or was on screen when its conversation was opened. A card that is
// mounted again (another tab and back, a parent that re-keys) never plays a second time.
const seen = new Set<string>()
const SEEN_MOST = 500
function remember(id: string) {
    seen.add(id)
    if (seen.size > SEEN_MOST) seen.delete(seen.values().next().value as string)
}
/** Marks what was already there when a view was opened: it will not play if it is mounted later. */
export function markDesktopArrivalSeen(id: string) { remember(id) }
export function desktopArrivalSeen(id: string) { return seen.has(id) }
export function resetDesktopArrivalsForTest() { seen.clear() }

/**
 * Tells what arrives live from what was saved. False while a view restores and for a moment after,
 * so everything a reopened conversation brings back is drawn settled; true from then on. A change
 * of `scopeKey` (another conversation) starts over.
 */
export function useDesktopLiveGate(scopeKey: string, ready: boolean, graceMs = 400): () => boolean {
    const armed = useRef<string | null>(null)
    const key = useRef(scopeKey)
    key.current = scopeKey
    useEffect(() => {
        if (!ready) return
        const timer = setTimeout(() => { armed.current = scopeKey }, graceMs)
        return () => { clearTimeout(timer); armed.current = null }
    }, [scopeKey, ready, graceMs])
    return useRef(() => armed.current === key.current).current
}

type ArriveTag = 'div' | 'li' | 'section'
export type DesktopArriveProps = Omit<HTMLAttributes<HTMLElement>, 'id'> & {
    /** What is arriving. The same id never plays twice while the app runs. */
    id: string
    /** It appeared while the person was looking, not from a saved conversation. Read once, on mount. */
    live: boolean
    /** One brief shake after it lands: for a request that is risky to answer without reading. */
    attention?: boolean
    /** Delay before it starts, for a few things arriving together. */
    delayMs?: number
    as?: ArriveTag
    children?: ReactNode
}

/**
 * The one "arrive" primitive for cards and rows. Live, it slides and fades in once; reopened,
 * scrolled back or mounted again, it is simply there.
 */
export function DesktopArrive({ id, live, attention = false, delayMs = 0, as = 'div', className, style, children, ...rest }: DesktopArriveProps) {
    const [arriving] = useState(() => live && !seen.has(id))
    useEffect(() => { remember(id) }, [id])
    return createElement(as, {
        ...rest,
        'data-desktop-arrive': arriving ? 'live' : 'settled',
        className: cn(arriving && DESKTOP_ARRIVE_CLASS, arriving && delayMs > 0 && 'fill-mode-backwards', className),
        style: arriving && delayMs > 0 ? { ...style, animationDelay: `${delayMs}ms` } : style,
    }, arriving && attention
        ? <div data-desktop-arrive-attention className="desktop-attention-shake">{children}</div>
        : children)
}

/**
 * A card settling into its outcome. When `stateKey` changes after the first render (its actions
 * give way to the line that says what was decided), the new content fades in instead of snapping.
 * The first render never animates, so a reopened, already-answered card is still.
 */
export function DesktopSettle({ stateKey, className, children }: { stateKey: string; className?: string; children: ReactNode }) {
    const first = useRef(stateKey)
    const settled = first.current !== stateKey
    return <div key={stateKey} data-desktop-settle={settled ? 'settled' : 'still'} className={cn(settled && DESKTOP_SETTLE_CLASS, className)}>{children}</div>
}
