'use client'

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { Orb, type OrbActivity } from '@rerun/ui/foreman'
import { cn } from '@/lib/utils'

/**
 * What the Chief of Staff is doing, as its orb shows it. The ball itself is upstream's `Orb`
 * (@rerun/ui/foreman), which already breathes, spins while it thinks and nods while it writes; the
 * Mac adds a soft aura around it for the states upstream has no word for: recording the person's
 * voice, reading a reply aloud, and waiting for an answer.
 */
export type DesktopOrbMood = 'idle' | 'thinking' | 'answering' | 'recording' | 'reading' | 'waiting'

/** One mood at a time. What the person is doing (speaking, listening) wins over what the model does. */
export function desktopOrbMood(input: { activity: OrbActivity; recording?: boolean; reading?: boolean; waiting?: boolean }): DesktopOrbMood {
    if (input.recording) return 'recording'
    if (input.reading) return 'reading'
    if (input.activity === 'thinking') return 'thinking'
    if (input.activity === 'speaking') return 'answering'
    return input.waiting ? 'waiting' : 'idle'
}

/** How upstream's ball moves under each mood. */
export const DESKTOP_ORB_ACTIVITY: Record<DesktopOrbMood, OrbActivity> = {
    idle: 'idle', thinking: 'thinking', answering: 'speaking', recording: 'listening', reading: 'speaking', waiting: 'idle',
}

type OrbStage = { mood: DesktopOrbMood; welcomes: number; claim: () => () => void }
const Stage = createContext<OrbStage | null>(null)

/**
 * One mood for every orb of a panel, and one orb that shows it. The large orb of a welcome takes the
 * lead while it is on screen; the small one in the header stands still until it is gone.
 */
export function DesktopForemanOrbStage({ mood, children }: { mood: DesktopOrbMood; children: ReactNode }) {
    const [welcomes, setWelcomes] = useState(0)
    const claim = useCallback(() => {
        setWelcomes(count => count + 1)
        return () => setWelcomes(count => count - 1)
    }, [])
    const stage = useMemo(() => ({ mood, welcomes, claim }), [mood, welcomes, claim])
    return <Stage.Provider value={stage}>{children}</Stage.Provider>
}

/** True while the element can be seen: in the viewport, in a window that is not hidden. */
function useSeen(element: Element | null): boolean {
    const [inView, setInView] = useState(true)
    const [shown, setShown] = useState(true)
    useEffect(() => {
        if (!element || typeof IntersectionObserver === 'undefined') return
        const observer = new IntersectionObserver(entries => setInView(entries.at(-1)?.isIntersecting ?? true))
        observer.observe(element)
        return () => observer.disconnect()
    }, [element])
    useEffect(() => {
        const sync = () => setShown(document.visibilityState !== 'hidden')
        sync()
        document.addEventListener('visibilitychange', sync)
        return () => document.removeEventListener('visibilitychange', sync)
    }, [])
    return inView && shown
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * The Chief of Staff's orb in a Mac panel: the small one in the header and the large one of a
 * welcome are this same component. It is decoration: hidden from assistive technology, never a
 * click target, and its aura ignores the pointer.
 */
export function DesktopForemanOrb({ role, size, activity, fallback, mood: ownMood, facing, paused = false, className }: {
    role: 'header' | 'welcome'
    size: number
    /** How the ball itself moves, when the place it is drawn in knows better than the mood. */
    activity?: OrbActivity
    /** Overrides the stage's mood. */
    mood?: DesktopOrbMood
    /** Drawn outside a stage: what the panel says the Chief of Staff is doing. */
    fallback?: OrbActivity
    facing?: 'left' | 'right' | 'front'
    /** Mounted but not shown (a folded column): nothing runs. */
    paused?: boolean
    className?: string
}) {
    const stage = useContext(Stage)
    const claim = stage?.claim
    useIsomorphicLayoutEffect(() => role === 'welcome' ? claim?.() : undefined, [role, claim])
    const [element, setElement] = useState<HTMLSpanElement | null>(null)
    const seen = useSeen(element)
    const mood = ownMood ?? stage?.mood ?? desktopOrbMood({ activity: fallback ?? 'idle' })
    const leads = role === 'welcome' || !stage || stage.welcomes === 0
    const still = !leads || paused || !seen
    return (
        <span ref={setElement} aria-hidden data-foreman-orb-role={role} data-orb-mood={mood} data-orb-still={still ? '' : undefined}
            className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
            <span className="desktop-orb-aura" />
            <span className="desktop-orb-ring" />
            <span className="desktop-orb-body relative block">
                <Orb size={size} state={activity ?? DESKTOP_ORB_ACTIVITY[mood]} paused={!leads || paused} facing={facing} />
            </span>
        </span>
    )
}
