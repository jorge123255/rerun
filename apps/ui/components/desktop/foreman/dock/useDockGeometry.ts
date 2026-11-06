'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ForemanPlacement } from '@/lib/foreman-layout'
import { boundedPlacement, dropPlacement, settleSheet, sheetHeight, type DockExtras, type Viewport } from '@/lib/desktop/foreman-dock/layout'

export type DockGesture = 'drag' | 'float-size' | 'dock-size' | 'sheet'
export function useDockGeometry(input: {
    scope: string; placement: ForemanPlacement; dock: DockExtras; open: boolean; hidden: boolean
    onPlacement: (placement: ForemanPlacement) => void; onDock: (dock: DockExtras) => void; onClose: () => void
}) {
    const latest = useRef(input); latest.current = input
    const [viewport, setViewport] = useState<Viewport>({ width: 1024, height: 768 })
    const [preview, setPreview] = useState<ForemanPlacement | null>(null)
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
    const [size, setSize] = useState<ForemanPlacement | null>(null)
    const [sheetOffset, setSheetOffset] = useState(0)
    const [sheet, setSheet] = useState<number | null>(null)
    const cancel = useRef<(() => void) | null>(null)
    const suppressClick = useRef(false)
    useEffect(() => {
        const resize = () => { cancel.current?.(); setViewport({ width: window.innerWidth, height: window.innerHeight }) }
        resize(); window.addEventListener('resize', resize)
        const interrupt = () => cancel.current?.()
        window.addEventListener('blur', interrupt)
        document.addEventListener('visibilitychange', interrupt)
        return () => { interrupt(); window.removeEventListener('resize', resize); window.removeEventListener('blur', interrupt); document.removeEventListener('visibilitychange', interrupt) }
    }, [])
    useEffect(() => { cancel.current?.() }, [input.scope, input.open, input.hidden])
    const begin = (kind: DockGesture, event: ReactPointerEvent<HTMLElement>) => {
        const current = latest.current
        if (document.hidden || event.button !== 0 || cancel.current || current.hidden || !current.open) return
        if (kind === 'drag' && (window.innerWidth < 768 || (event.target instanceof Element && event.target.closest('button,a,input,textarea,[role="tablist"]')))) return
        const panel = event.currentTarget.closest<HTMLElement>('[data-desktop-foreman-panel]')
        if (!panel) return
        const origin = current.placement, scope = current.scope, rect = panel.getBoundingClientRect()
        const start = { x: event.clientX, y: event.clientY, t: event.timeStamp }
        const pointerId = event.pointerId
        const v = { width: window.innerWidth, height: window.innerHeight }
        const float = boundedPlacement(origin, v)
        const grab = { x: Math.min(Math.max(start.x - rect.left, 24), float.width - 24), y: Math.min(start.y - rect.top, 80) }
        let moved = false, target = origin, detent: 'medium' | 'large' | 'dismiss' = current.dock.sheetDetent ?? 'large'
        let samples = [{ y: start.y, t: start.t }]
        const cursor = document.body.style.cursor, userSelect = document.body.style.userSelect
        const move = (e: PointerEvent) => {
            if (e.pointerId !== pointerId) return
            const dx = e.clientX - start.x, dy = e.clientY - start.y
            if (!moved && Math.hypot(dx, dy) < 6) return
            moved = true; suppressClick.current = true
            document.body.style.userSelect = 'none'; document.body.style.cursor = kind === 'drag' ? 'grabbing' : 'resize'
            if (kind === 'drag') {
                const p = { x: Math.min(v.width - 24, Math.max(24 - float.width, e.clientX - grab.x)), y: Math.min(v.height - 48, Math.max(0, e.clientY - grab.y)) }
                setPosition(p)
                target = dropPlacement({ x: e.clientX, y: e.clientY }, { x: p.x + float.width / 2, y: p.y + float.height / 2 }, origin, v)
                setPreview(target)
            } else if (kind === 'sheet') {
                samples.push({ y: e.clientY, t: e.timeStamp }); samples = samples.filter(s => e.timeStamp - s.t <= 100)
                const first = samples[0] ?? { y: start.y, t: start.t }
                const velocity = e.timeStamp > first.t ? (e.clientY - first.y) / (e.timeStamp - first.t) : 0
                detent = settleSheet(rect.height, dy, velocity, v.height)
                const raw = rect.height - dy, floor = sheetHeight('medium', v.height), large = sheetHeight('large', v.height)
                const room = Math.max(v.height - large, 1)
                const rubber = (overshoot: number) => (1 - 1 / (overshoot * 0.55 / room + 1)) * room
                setSheet(raw > large ? large + rubber(raw - large) : Math.max(floor, raw))
                setSheetOffset(Math.max(floor - raw, 0))
            } else {
                target = kind === 'dock-size'
                    ? { ...origin, dockWidth: rect.width + (origin.mode === 'dock' && origin.side === 'right' ? -dx : dx) }
                    : { ...origin, width: rect.width + (origin.mode === 'float' && origin.corner.endsWith('right') ? -dx : dx), height: rect.height + (origin.mode === 'float' && origin.corner.startsWith('bottom') ? -dy : dy) }
                target = boundedPlacement(target, v); setSize(target)
            }
        }
        const finish = (commit: boolean) => {
            window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', abort); window.removeEventListener('keydown', key, true)
            document.body.style.cursor = cursor; document.body.style.userSelect = userSelect
            cancel.current = null; setPreview(null); setPosition(null); setSize(null); setSheet(null); setSheetOffset(0)
            if (!commit || !moved || latest.current.scope !== scope || !latest.current.open || latest.current.hidden) return
            if (kind === 'sheet') {
                if (detent === 'dismiss') latest.current.onClose()
                else latest.current.onDock({ ...latest.current.dock, sheetDetent: detent })
            } else latest.current.onPlacement(target)
        }
        const up = (e: PointerEvent) => { if (e.pointerId === pointerId) finish(true) }
        const abort = (e: PointerEvent) => { if (e.pointerId === pointerId) finish(false) }
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false) } }
        cancel.current = () => finish(false)
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', abort); window.addEventListener('keydown', key, true)
    }
    return { viewport, sheetOffset, placement: boundedPlacement(size ?? input.placement, viewport), preview, position, sheetHeight: sheet ?? sheetHeight(input.dock.sheetDetent, viewport.height), begin,
        consumeClick() { const suppressed = suppressClick.current; suppressClick.current = false; return suppressed } }
}
