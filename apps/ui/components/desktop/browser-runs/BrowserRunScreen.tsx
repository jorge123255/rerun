'use client'

import { AnimatePresence } from 'motion/react'
import { useCallback, useState, type ComponentType, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { DesktopScreenLoader } from '@/components/desktop/DesktopScreenLoader'
import { DesktopViewer } from '@/components/desktop/DesktopViewer'
import { FloatingScreen } from '@/components/desktop/FloatingScreen'
import { ScreenCard } from '@/components/desktop/ScreenCard'
import { ScreenFace } from '@/components/desktop/ScreenFace'
import { ScreenMirror } from '@/components/desktop/ScreenMirror'
import { Button } from '@/components/ui/button'
import { useSeenInThread } from '@/hooks/useSeenInThread'
import { MonitorIcon } from '@/lib/icons'
import { projectBrowserRunScreen, runKey, type BrowserRunIdentity, type BrowserRunScreenState, type CurrentRunCheck, type PassiveViewerTransport, type TrustedCurrentRun } from '@/lib/desktop/browser-run'

import { usePageVisible, useBrowserRunScreen } from './useBrowserRunScreen'

export const SCREEN_CONTROL_LABEL = 'Take control'
const OPEN_FAILED = 'The browser could not be opened.'

type ViewerProps = { socketUrl: string; viewOnly: true; onDisconnect: () => void; onCanvas: (canvas: HTMLCanvasElement | null) => void }

export type BrowserRunScreenProps = {
    /** Root's trusted current-run projection for this conversation, or null. */
    trusted: TrustedCurrentRun | null
    agentId: string
    sessionId: string
    /** This conversation is the one on screen (tab + board selection), from root. */
    active: boolean
    selected: boolean
    /** Root's pending takeover for this exact session: its own card owns the screen and controls. */
    takeoverPending: boolean
    /** Root's full IsolatedScreenDialog is open for this coworker. */
    fullViewerOpen: boolean
    checkCurrentRun: CurrentRunCheck
    transport: PassiveViewerTransport
    /** Acknowledged: resolves once root opened the full dialog for exactly this run; rejects otherwise. */
    onOpenFullViewer: (run: BrowserRunIdentity) => Promise<void>
    scroller: HTMLElement | null
    floatingHost: HTMLElement | null
    arriveRef?: RefObject<HTMLDivElement | null>
    /** The run's ordinary activity loader, shown whenever there is no eligible screen. */
    fallback: ReactNode
    /** Test seam; defaults to the existing DesktopViewer. */
    Viewer?: ComponentType<ViewerProps>
}

// Adapted from original ChatScreen: the coworker's screen as the last block of the run that uses it.
export function BrowserRunScreen({ trusted, agentId, sessionId, active, selected, takeoverPending, ...block }: BrowserRunScreenProps) {
    const visible = usePageVisible()
    const eligibility = projectBrowserRunScreen({ trusted, conversation: { agentId, sessionId, active, selected, visible }, takeoverPending })
    if (!eligibility.eligible) return block.fallback
    return <BrowserRunBlock key={runKey(eligibility.run)} run={eligibility.run} site={eligibility.site} {...block} />
}

type BlockProps = Omit<BrowserRunScreenProps, 'trusted' | 'agentId' | 'sessionId' | 'active' | 'selected' | 'takeoverPending'> & { run: BrowserRunIdentity; site: string | null }

function BrowserRunBlock({ run, site, checkCurrentRun, transport, onOpenFullViewer, fullViewerOpen, scroller, floatingHost, arriveRef, fallback, Viewer = DesktopViewer }: BlockProps) {
    const { state, retry, onConnected, onDisconnect } = useBrowserRunScreen(run, checkCurrentRun, transport)
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
    const [card, setCard] = useState<HTMLDivElement | null>(null)
    const [opening, setOpening] = useState(false)
    const [openError, setOpenError] = useState<string | null>(null)
    const cardSeen = useSeenInThread(card, scroller)

    const cardRef = useCallback(
        (node: HTMLDivElement | null) => {
            setCard(node)
            if (arriveRef) arriveRef.current = node
        },
        [arriveRef]
    )

    const live = state.status === 'live'
    const socketUrl = live ? state.socketUrl : null
    const handleCanvas = useCallback(
        (next: HTMLCanvasElement | null) => {
            setCanvas(next)
            if (next && socketUrl) onConnected(socketUrl)
        },
        [onConnected, socketUrl]
    )

    const open = () => {
        if (opening) return
        setOpening(true)
        setOpenError(null)
        // Not a takeover answer: this only asks root to show its existing dialog for this run.
        onOpenFullViewer(run)
            .catch(() => setOpenError(OPEN_FAILED))
            .finally(() => setOpening(false))
    }

    if (state.status === 'stopped' || state.status === 'idle') return fallback

    const face = <BrowserRunFace state={state} onRetry={retry}>{socketUrl && <Viewer key={socketUrl} viewOnly socketUrl={socketUrl} onDisconnect={() => onDisconnect(socketUrl)} onCanvas={handleCanvas} />}</BrowserRunFace>
    return (
        <>
            <div className="flex w-full flex-col gap-1">
                <ScreenCard ref={cardRef} live={live && !opening} site={live ? (state.site ?? site) : null} screen={face} onTakeControl={open} />
                {openError && (
                    <div role="alert" className="flex max-w-[95%] flex-wrap items-center gap-2 text-xs text-destructive">
                        <span>{openError}</span>
                        <Button type="button" size="sm" variant="ghost" onClick={open} disabled={opening}>Try again</Button>
                    </div>
                )}
            </div>
            {floatingHost &&
                createPortal(
                    <AnimatePresence>
                        {!cardSeen && !fullViewerOpen && live && (
                            <FloatingScreen key="mini" className="top-1" takeControlLabel={SCREEN_CONTROL_LABEL} onTakeControl={open}>
                                <ScreenFace status="live">{canvas ? <ScreenMirror source={canvas} /> : <DesktopScreenLoader compact className="bg-muted/40" />}</ScreenFace>
                            </FloatingScreen>
                        )}
                    </AnimatePresence>,
                    floatingHost
                )}
        </>
    )
}

// ScreenFace for loading/live/disconnected, plus the unavailable reason and a Retry that revalidates.
function BrowserRunFace({ state, onRetry, children }: { state: Exclude<BrowserRunScreenState, { status: 'idle' } | { status: 'stopped' }>; onRetry: () => void; children: ReactNode }) {
    if (state.status === 'loading') return <ScreenFace status="loading">{null}</ScreenFace>
    if (state.status === 'live') return <ScreenFace status="live">{children}</ScreenFace>
    return (
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-1.5 bg-muted/40 px-4 text-center text-muted-foreground">
            <MonitorIcon className="size-5" />
            <p className="text-xs">{state.reason}</p>
            <Button type="button" size="sm" variant="outline" className="relative z-10 mt-1" onClick={onRetry}>Try again</Button>
        </div>
    )
}
