'use client'

import { ChromePill } from '@rerun/ui/chrome'
import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DesktopGettingStartedStep, DesktopGettingStartedStepId } from '@/lib/desktop/getting-started/progress'
import { desktopGettingStartedSummary } from '@/lib/desktop/getting-started/progress'
import { DesktopGettingStartedPanel, DesktopGettingStartedProgressMark } from './DesktopGettingStartedPanel'
import { useDesktopLocale } from '../DesktopLocale'

const HOVER_CLOSE_DELAY_MS = 150

/** Board furniture. Hover opens it for a mouse, a tap opens it for a finger. It does not talk to the Foreman. */
export function DesktopGettingStartedPopover({ steps, open, onOpenChange, onStep, onHide }: {
    steps: readonly DesktopGettingStartedStep[]
    open: boolean
    onOpenChange: (open: boolean) => void
    onStep: (id: DesktopGettingStartedStepId) => void
    onHide: () => void
}) {
    const summary = desktopGettingStartedSummary(steps)
    const { t } = useDesktopLocale()
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const openedByHover = useRef(false)
    const cancelClose = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current)
        closeTimer.current = null
    }
    useEffect(() => cancelClose, [])
    useEffect(() => {
        if (!open) openedByHover.current = false
    }, [open])
    const openOnHover = (event: PointerEvent) => {
        if (event.pointerType !== 'mouse') return
        cancelClose()
        if (open) return
        openedByHover.current = true
        onOpenChange(true)
    }
    const keepHoverOpen = (event: MouseEvent) => {
        if (!openedByHover.current) return
        openedByHover.current = false
        event.preventDefault()
    }
    const closeOnLeave = (event: PointerEvent) => {
        if (event.pointerType !== 'mouse') return
        cancelClose()
        closeTimer.current = setTimeout(() => {
            openedByHover.current = false
            onOpenChange(false)
        }, HOVER_CLOSE_DELAY_MS)
    }

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <ChromePill
                    start="gauge"
                    beamTone="brand"
                    beamAnimated={!summary.complete}
                    aria-label={t('gettingStarted.pillLabel', { done: summary.done, total: summary.total })}
                    onPointerEnter={openOnHover}
                    onPointerLeave={closeOnLeave}
                    onClick={keepHoverOpen}
                >
                    <DesktopGettingStartedProgressMark done={summary.done} total={summary.total} className="relative" />
                    <span className="relative tabular-nums">{summary.done}/{summary.total}</span>
                </ChromePill>
            </PopoverTrigger>
            <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                onPointerEnter={openOnHover}
                onPointerLeave={closeOnLeave}
                onOpenAutoFocus={event => event.preventDefault()}
                className="w-80"
            >
                <DesktopGettingStartedPanel steps={steps} onStep={onStep} onHide={onHide} />
            </PopoverContent>
        </Popover>
    )
}
