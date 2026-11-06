import { clampForemanDockWidth, clampForemanFloatSize, resolveDropTarget, type ForemanCorner, type ForemanPlacement } from '@/lib/foreman-layout'

export type Viewport = { width: number; height: number }
export type DockExtras = { orbCorner: ForemanCorner; sheetDetent: 'medium' | 'large' | null }
export const DEFAULT_DOCK_EXTRAS: DockExtras = { orbCorner: 'bottom-right', sheetDetent: null }
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
export function viewportSize(viewport: Viewport): Viewport {
    return { width: Math.max(1, finite(viewport.width, 1)), height: Math.max(1, finite(viewport.height, 1)) }
}
export function boundedPlacement(placement: ForemanPlacement, viewport: Viewport): ForemanPlacement {
    const v = viewportSize(viewport)
    const size = clampForemanFloatSize({ width: finite(placement.width, 480), height: finite(placement.height, 720) }, v)
    return { ...placement, width: Math.min(size.width, Math.max(1, v.width - 32)), height: Math.min(size.height, Math.max(1, v.height - 32)), dockWidth: Math.min(clampForemanDockWidth(finite(placement.dockWidth, 480), v.width), Math.max(1, v.width - 32)) }
}
export function dropPlacement(pointer: { x: number; y: number }, center: { x: number; y: number }, placement: ForemanPlacement, viewport: Viewport) {
    return resolveDropTarget({ pointer, panelCenter: center, size: { width: placement.width, height: placement.height, dockWidth: placement.dockWidth }, viewport: viewportSize(viewport) })
}
export function sheetHeight(detent: DockExtras['sheetDetent'], height: number) {
    return Math.max(1, Math.min(height - 16, height * (detent === 'medium' ? 0.5 : 0.96)))
}
export function settleSheet(startHeight: number, delta: number, velocity: number, viewportHeight: number) {
    const medium = sheetHeight('medium', viewportHeight), large = sheetHeight('large', viewportHeight)
    const raw = startHeight - delta
    if (raw < medium && (medium - raw > medium * 0.25 || velocity > 0.4)) return 'dismiss' as const
    const projected = Math.max(medium, raw - velocity * 0.998 / (1 - 0.998))
    return Math.abs(projected - medium) < Math.abs(projected - large) ? 'medium' as const : 'large' as const
}

export function savedPlacement(placement: ForemanPlacement): ForemanPlacement {
    const size = (n: number, fallback: number) => Math.round(Math.min(4096, Math.max(100, finite(n, fallback))))
    return { ...placement, width: size(placement.width, 480), height: size(placement.height, 720), dockWidth: size(placement.dockWidth, 480) }
}
