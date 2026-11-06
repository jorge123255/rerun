'use client'

import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'

import { usePageVisible } from '../browser-runs/useBrowserRunScreen'
import { ownerKey } from '@/lib/desktop/computer-panel/controller'
import { BrowserRunScreen } from '@/components/desktop/browser-runs/BrowserRunScreen'
import { Button } from '@/components/ui/button'
import { MonitorIcon, XIcon } from '@/lib/icons'
import type { ComputerPanelOwner, ComputerPanelPorts } from '@/lib/desktop/computer-panel/contract'

import { ComputerLaunchControls } from './ComputerLaunchControls'
import { useComputerPanel, type ReadComputerPanelProjection } from './useComputerPanel'

export type ComputerPanelProps = {
    agentId: string
    sessionId: string
    /** Root: this conversation is the open tab and the board-selected coworker. */
    active: boolean
    selected: boolean
    /** Root's IsolatedScreenDialog is open for this coworker (hides the floating mini screen). */
    fullViewerOpen: boolean
    readProjection: ReadComputerPanelProjection
    ports: ComputerPanelPorts
    /** True only once root mounts H-A1; otherwise Terminal/Files show a truthful unavailable reason. */
    humanLaunchMounted: boolean
    scroller: HTMLElement | null
    floatingHost: HTMLElement | null
    arriveRef?: RefObject<HTMLDivElement | null>
    /** Original activity loader shown whenever no screen is warranted. */
    fallback: ReactNode
    /** Where focus returns after Escape / Hide (the composer), so drafts stay where they were. */
    onReturnFocus?: () => void
}

/**
 * Adapted original ChatScreen block: last block of the run, reusing the accepted BrowserRunScreen
 * (same ScreenCard/FloatingScreen/DesktopViewer) for watching, plus the DesktopNotch launcher row.
 * Take control / Browser only ask root to open its existing dialog, which owns the exact lease.
 */
export function ComputerPanel(props: ComputerPanelProps) {
    const { agentId, sessionId, active, selected, ports, readProjection, humanLaunchMounted, onReturnFocus } = props
    const visible = usePageVisible()
    const panel = useComputerPanel({ agentId, sessionId, active, selected, visible }, readProjection, ports, humanLaunchMounted)
    const regionRef = useRef<HTMLDivElement>(null)
    const { presentation } = panel
    const owner = presentation.show ? presentation.owner : null

    const scope = useRef<AbortController | null>(null)
    const live = useRef({ active, selected, visible, owner }); live.current = { active, selected, visible, owner }
    const currentKey = owner ? ownerKey(owner) : null
    useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort() }, [agentId, sessionId, active, selected, visible, currentKey])
    const openFull = useCallback(async (intent: { app: 'browser' } | { takeoverId: string }, expected: ComputerPanelOwner | null) => {
        if (!expected) throw new Error('This run ended')
        const controller = scope.current
        if (!controller) throw new Error('This run ended')
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])
        const ok = await ports.revalidateOwner(expected, signal)
        signal.throwIfAborted()
        if (!ok || !live.current.active || !live.current.selected || !live.current.visible || !live.current.owner || ownerKey(live.current.owner) !== ownerKey(expected)) throw new Error('This run ended')
        await ports.openFullViewer(expected, intent)
    }, [ports])

    const hide = () => { panel.dismiss(); onReturnFocus?.() }
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault(); hide()
    }

    if (panel.wasDismissed) {
        return (
            <div className="flex flex-col gap-1">
                {props.fallback}
                <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={panel.reopen}><MonitorIcon className="size-4" />Show screen</Button>
            </div>
        )
    }
    if (!presentation.show) {
        return (
            <div className="flex flex-col gap-1">
                {props.fallback}
                {presentation.reason === 'runtime' && presentation.runtimeReason && <p role="status" className="text-xs text-muted-foreground">{presentation.runtimeReason}</p>}
            </div>
        )
    }

    const trusted = panel.projection?.current ?? null
    return (
        <div ref={regionRef} role="region" aria-label="Coworker screen" tabIndex={-1} onKeyDown={onKeyDown}
            className="group/panel relative flex w-full flex-col gap-1.5 motion-reduce:transition-none [@media(max-height:560px)]:max-w-[70%]">
            <BrowserRunScreen trusted={trusted} agentId={agentId} sessionId={sessionId} active={active} selected={selected}
                takeoverPending={false} fullViewerOpen={props.fullViewerOpen}
                checkCurrentRun={ports.checkCurrentRun} transport={ports.transport}
                onOpenFullViewer={() => openFull(presentation.takeover ? { takeoverId: presentation.takeover.takeoverId } : { app: 'browser' }, owner)}
                scroller={props.scroller} floatingHost={props.floatingHost} arriveRef={props.arriveRef} fallback={props.fallback} />
            <div className="flex max-w-[95%] items-center justify-between gap-2">
                <ComputerLaunchControls availability={panel.availability} attempt={panel.attempt}
                    onBrowser={() => void openFull({ app: 'browser' }, owner).catch(() => undefined)}
                    onLaunch={panel.launch} onClearAttempt={panel.clearAttempt} />
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Hide screen" title="Hide screen" onClick={hide}><XIcon className="size-4" /></Button>
            </div>
            {presentation.mode === 'drive' && <p role="status" className="text-xs text-muted-foreground">You are driving</p>}
        </div>
    )
}
