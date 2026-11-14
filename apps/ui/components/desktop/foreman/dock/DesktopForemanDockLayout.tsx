'use client'

import { useDesktopLocale } from '../../DesktopLocale'

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type PointerEventHandler, type KeyboardEventHandler } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import type { ForemanPlacement } from '@/lib/foreman-layout'
import { cn } from '@/lib/utils'
import { boundedPlacement, type DockExtras } from '@/lib/desktop/foreman-dock/layout'
import { useDockGeometry } from './useDockGeometry'

const CORNERS = {
    'top-left': { top: 'calc(16px + var(--board-inset,0px))', left: 'calc(16px + var(--board-inset,0px))' }, 'top-right': { top: 'calc(16px + var(--board-inset,0px))', right: 'calc(16px + var(--board-inset,0px))' },
    'bottom-left': { bottom: 'calc(16px + var(--board-inset,0px))', left: 'calc(16px + var(--board-inset,0px))' }, 'bottom-right': { bottom: 'calc(16px + var(--board-inset,0px))', right: 'calc(16px + var(--board-inset,0px))' },
} as const
export type DockHeaderBindings = { onPointerDown: PointerEventHandler<HTMLElement> }
export type DesktopForemanDockLayoutProps = {
    scope: string; open: boolean; hidden?: boolean; placement: ForemanPlacement; dock: DockExtras
    onPlacement: (placement: ForemanPlacement) => void; onDock: (dock: DockExtras) => void; onClose: () => void
    onLayout?: (layout: { scope: string; open: boolean; placement: ForemanPlacement; dragging: boolean; mobile: boolean }) => void
    returnFocus: () => HTMLElement | null
    // The panel takes the whole of the space it is given, as the Simple view's middle column does:
    // no docking, floating, dragging or resizing while it does.
    fill?: boolean
    children: (header: DockHeaderBindings) => ReactNode
}

/** One frame around the existing column CONTENT; the board remains a mounted sibling. */
export function DesktopForemanDockLayout(props: DesktopForemanDockLayoutProps) {
    const { t } = useDesktopLocale()
    const reduce = useReducedMotion()
    const geometry = useDockGeometry({ ...props, hidden: !!props.hidden })
    const { placement: p, viewport: v, position } = geometry
    const mobile = v.width < 768
    const layoutCallback = useRef(props.onLayout); layoutCallback.current = props.onLayout
    useLayoutEffect(() => {
        layoutCallback.current?.({ scope: props.scope, open: props.open && !props.hidden, placement: p, dragging: !!position, mobile })
    }, [props.scope, props.open, props.hidden, p.mode, p.mode === 'dock' ? p.side : p.corner, p.width, p.height, p.dockWidth, !!position, mobile])
    const panel = useRef<HTMLDivElement>(null)
    const wasOpen = useRef(props.open)
    useEffect(() => {
        if (wasOpen.current && !props.open) {
            const target = props.returnFocus()
            if (target?.isConnected && !document.hidden) target.focus({ preventScroll: true })
        }
        wasOpen.current = props.open
    }, [props.open, props.returnFocus])
    const rectStyle = (placement: ForemanPlacement): CSSProperties => mobile
        ? { position: 'fixed', bottom: 0, left: 0, right: 0, width: '100%', height: geometry.sheetHeight, translate: geometry.sheetOffset ? `0 ${geometry.sheetOffset}px` : undefined, maxHeight: 'calc(96dvh - env(safe-area-inset-top))' }
        : placement.mode === 'float'
            ? { position: 'fixed', ...CORNERS[placement.corner], width: placement.width, height: placement.height, maxWidth: 'calc(100vw - 32px - 2*var(--board-inset,0px))', maxHeight: 'calc(100dvh - 32px - 2*var(--board-inset,0px))' }
            : { position: 'relative', height: '100%', width: placement.dockWidth, gridColumn: placement.side === 'left' ? 1 : 3, gridRow: 1 }
    const fill = !!props.fill && !mobile
    const style: CSSProperties = fill ? { position: 'relative', height: '100%', width: '100%', gridColumn: '1 / -1', gridRow: 1 }
        : position ? { position: 'fixed', top: position.y, left: position.x, width: p.width, height: p.height } : rectStyle(p)
    const growLeft = p.mode === 'float' && p.corner.endsWith('right'), growUp = p.mode === 'float' && p.corner.startsWith('bottom')
    const resizeKey: KeyboardEventHandler<HTMLElement> = e => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return
        e.preventDefault(); e.stopPropagation()
        if (e.altKey) {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') props.onPlacement({ ...props.placement, mode: 'dock', side: e.key === 'ArrowLeft' ? 'left' : 'right' })
            else props.onPlacement({ ...props.placement, mode: 'float', corner: `${e.key === 'ArrowUp' ? 'top' : 'bottom'}-${p.mode === 'dock' ? p.side : p.corner.endsWith('left') ? 'left' : 'right'}` })
            return
        }
        const dx = e.key === 'ArrowRight' ? 24 : e.key === 'ArrowLeft' ? -24 : 0
        const dy = e.key === 'ArrowDown' ? 24 : e.key === 'ArrowUp' ? -24 : 0
        const next: ForemanPlacement = e.key === 'Home' ? { ...props.placement, width: 480, height: 720, dockWidth: 480 } : p.mode === 'dock'
            ? { ...props.placement, dockWidth: p.dockWidth + (p.side === 'right' ? -dx : dx) }
            : { ...props.placement, width: p.width + (growLeft ? -dx : dx), height: p.height + (growUp ? -dy : dy) }
        props.onPlacement(boundedPlacement(next, v))
    }
    return <>
        <AnimatePresence>{geometry.preview && <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.18 }} style={{ ...rectStyle(boundedPlacement(geometry.preview, v)), position: 'fixed', ...(geometry.preview.mode === 'dock' ? { top: 8, bottom: 8, height: 'auto', [geometry.preview.side]: 8 } : {}), borderRadius: 14 }} className="pointer-events-none z-40 border-2 border-primary/40 bg-primary/5" />}</AnimatePresence>
        <motion.div layout={!position && !reduce} transition={{ duration: reduce ? 0 : 0.22, ease: 'easeOut' }} ref={panel} data-desktop-foreman-panel hidden={!!props.hidden} aria-hidden={!props.open} inert={!props.open || !!props.hidden} animate={{ opacity: props.open ? 1 : 0, y: mobile && !props.open ? '100%' : 0, scale: !props.open && p.mode === 'float' ? 0.95 : 1 }} style={{ ...style, pointerEvents: props.open && !props.hidden ? 'auto' : 'none' }}
            className={cn('z-50 min-h-0 min-w-0 max-w-full rounded-xl border border-border bg-background shadow-2xl motion-reduce:transition-none', mobile && 'rounded-t-2xl', p.mode === 'dock' && !mobile && 'rounded-3xl shadow', fill && 'rounded-none border-0 shadow-none')}>
            {mobile && <button type="button" data-sheet-grabber aria-label={t('foreman.resize')} className="absolute inset-x-0 top-0 z-30 flex h-6 w-full touch-none items-center justify-center" onPointerDown={e => geometry.begin('sheet', e)} onClick={() => { if (!geometry.consumeClick()) props.onDock({ ...props.dock, sheetDetent: props.dock.sheetDetent === 'medium' ? 'large' : 'medium' }) }}><span className="h-1 w-10 rounded-full bg-muted-foreground/30" /></button>}
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[inherit]">{props.children({ onPointerDown: e => { if (!fill) geometry.begin('drag', e) } })}</div>
            {!mobile && !fill && <div role="separator" tabIndex={0} aria-label={t('foreman.resize')} aria-orientation={p.mode === 'dock' ? 'vertical' : undefined}
                className={cn('absolute z-30 touch-none border-transparent hover:border-ring/70 focus-visible:border-ring focus-visible:outline-none', p.mode === 'dock' ? `inset-y-0 w-2 cursor-col-resize ${p.side === 'right' ? 'left-0' : 'right-0'}` : `size-4 border-2 ${growLeft ? 'left-0' : 'right-0'} ${growUp ? 'top-0' : 'bottom-0'} ${growLeft === growUp ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`)}
                onPointerDown={e => geometry.begin(p.mode === 'dock' ? 'dock-size' : 'float-size', e)} onKeyDown={resizeKey} onDoubleClick={() => props.onPlacement({ ...props.placement, width: 480, height: 720, dockWidth: 480 })} />}
        </motion.div>
    </>
}
