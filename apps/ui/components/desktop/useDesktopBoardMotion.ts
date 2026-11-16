'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@rerun/ui/iso-grid'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import { BOARD_BOUNCE_MS, BOARD_CELEBRATE_WINDOW_MS, boardEntrancePlan } from '@/lib/desktop/board-motion'

const NONE: ReadonlyMap<string, number> = new Map()
const still = (reducedMotion: boolean) => reducedMotion || (typeof document !== 'undefined' && document.visibilityState === 'hidden')

/**
 * Which Boxes and coworkers are arriving on the board right now, and how long each waits before
 * its entrance. Only what appears while the board is open arrives: everything on it when it
 * opens (a reload, a restart, another workspace) is simply there. Each coworker and Box arrives
 * once. With Reduce motion on, or while the window is hidden, nothing arrives: it is simply there.
 *
 * `celebrateSignal` changes when a team build has finished. If coworkers arrived for it, `onCelebrate`
 * is called once, as the last of them lands. A signal with no arrival behind it (the finished build
 * a restart reads again) celebrates nothing.
 */
export function useBoardEntrances({ scope, tileIds, boxIds, celebrateSignal = 0, onCelebrate }: {
    scope: string
    tileIds: readonly string[]
    boxIds: readonly string[]
    celebrateSignal?: number
    onCelebrate?: () => void
}): { tiles: ReadonlyMap<string, number>; boxes: ReadonlyMap<string, number> } {
    const reducedMotion = usePrefersReducedMotion()
    const [arriving, setArriving] = useState<{ tiles: ReadonlyMap<string, number>; boxes: ReadonlyMap<string, number> }>({ tiles: NONE, boxes: NONE })
    const seen = useRef<{ scope: string; tiles: Set<string>; boxes: Set<string> } | null>(null)
    const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
    // Coworkers that arrived and have not been celebrated: how many, when, and when they land.
    const uncelebrated = useRef({ count: 0, at: 0, landsAt: 0 })
    const celebrate = useRef(onCelebrate)
    celebrate.current = onCelebrate
    const tileKey = tileIds.join('\0')
    const boxKey = boxIds.join('\0')

    useLayoutEffect(() => {
        const known = seen.current
        if (!known || known.scope !== scope) {
            // The board as it opens: nothing on it arrives.
            seen.current = { scope, tiles: new Set(tileIds), boxes: new Set(boxIds) }
            uncelebrated.current = { count: 0, at: 0, landsAt: 0 }
            if (known) { for (const timer of timers.current) clearTimeout(timer); timers.current.clear(); setArriving({ tiles: NONE, boxes: NONE }) }
            return
        }
        const newTiles = tileIds.filter(id => !known.tiles.has(id))
        const newBoxes = boxIds.filter(id => !known.boxes.has(id))
        if (!newTiles.length && !newBoxes.length) return
        for (const id of newTiles) known.tiles.add(id)
        for (const id of newBoxes) known.boxes.add(id)
        if (still(reducedMotion)) return
        const plan = boardEntrancePlan(newBoxes, newTiles)
        const now = Date.now()
        if (newTiles.length) uncelebrated.current = { count: uncelebrated.current.count + newTiles.length, at: now, landsAt: Math.max(uncelebrated.current.landsAt, now + plan.endsAt) }
        setArriving(current => ({ tiles: new Map([...current.tiles, ...plan.tiles]), boxes: new Map([...current.boxes, ...plan.boxes]) }))
        // Once landed they are ordinary tiles again, so a remounted grid cannot replay the entrance.
        const timer = setTimeout(() => {
            timers.current.delete(timer)
            setArriving(current => ({
                tiles: new Map([...current.tiles].filter(([id]) => !plan.tiles.has(id))),
                boxes: new Map([...current.boxes].filter(([id]) => !plan.boxes.has(id))),
            }))
        }, plan.endsAt + 50)
        timers.current.add(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the id lists are compared by content
    }, [scope, tileKey, boxKey, reducedMotion])

    const celebrated = useRef(celebrateSignal)
    useEffect(() => {
        if (celebrated.current === celebrateSignal) return
        celebrated.current = celebrateSignal
        const arrival = uncelebrated.current
        uncelebrated.current = { count: 0, at: 0, landsAt: 0 }
        const now = Date.now()
        if (!arrival.count || now - arrival.at > BOARD_CELEBRATE_WINDOW_MS || still(reducedMotion)) return
        // As the last coworker touches down, not after its settle has fully played out.
        const timer = setTimeout(() => { timers.current.delete(timer); celebrate.current?.() }, Math.max(0, arrival.landsAt - now - 300))
        timers.current.add(timer)
    }, [celebrateSignal, reducedMotion])

    useEffect(() => {
        const pending = timers.current
        return () => { for (const timer of pending) clearTimeout(timer); pending.clear() }
    }, [])

    return reducedMotion ? { tiles: NONE, boxes: NONE } : arriving
}

/**
 * The coworkers whose run has just finished: each gets one small bounce, held for
 * `BOARD_BOUNCE_MS`. Read from the statuses the board already has; a coworker that was not seen
 * working (the first read after the board opens) does not bounce.
 */
export function useBoardBounces(statuses: Readonly<Record<string, BoardActivityStatus>>): ReadonlySet<string> {
    const reducedMotion = usePrefersReducedMotion()
    const [bouncing, setBouncing] = useState<ReadonlySet<string>>(() => new Set())
    const previous = useRef(statuses)
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
    useEffect(() => {
        const before = previous.current
        previous.current = statuses
        if (before === statuses || still(reducedMotion)) return
        const finished = Object.keys(statuses).filter(id => before[id] === 'working' && (statuses[id] === 'idle' || statuses[id] === 'waiting_human'))
        if (!finished.length) return
        setBouncing(current => new Set([...current, ...finished]))
        for (const id of finished) {
            clearTimeout(timers.current.get(id))
            timers.current.set(id, setTimeout(() => {
                timers.current.delete(id)
                setBouncing(current => { const next = new Set(current); next.delete(id); return next })
            }, BOARD_BOUNCE_MS))
        }
    }, [statuses, reducedMotion])
    useEffect(() => {
        const pending = timers.current
        return () => { for (const timer of pending.values()) clearTimeout(timer); pending.clear() }
    }, [])
    return bouncing
}
