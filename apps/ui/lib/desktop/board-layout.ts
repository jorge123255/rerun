import { DEFAULT_SPAN, agentsOverlap, containerContainsTile } from '@rerun/ui/iso-grid/iso'

export type DesktopBoardPosition = { col: number; row: number }
type BoardAgent = { id: string; position?: DesktopBoardPosition | null }
type Layout = {
    positions: Map<string, DesktopBoardPosition>
    bounds: { col_start: number; row_start: number; col_end: number; row_end: number }
}

function vacant(positions: Map<string, DesktopBoardPosition>, anchor: DesktopBoardPosition) {
    for (const occupied of positions.values()) if (agentsOverlap(occupied, anchor)) return false
    return true
}

export function canPlaceDesktopCopy(layout: Layout, anchor: DesktopBoardPosition) {
    return Number.isSafeInteger(anchor.col) && Number.isSafeInteger(anchor.row)
        && containerContainsTile(layout.bounds, anchor, DEFAULT_SPAN) && vacant(layout.positions, anchor)
}

export function desktopBoardLayout(agents: readonly BoardAgent[]) {
    const positions = new Map<string, DesktopBoardPosition>()
    for (const agent of agents) if (agent.position) positions.set(agent.id, agent.position)

    // A placed copy keeps its chosen cells. Other coworkers use the original desktop grid.
    const auto = agents.filter(agent => !agent.position)
    const columns = Math.max(1, Math.ceil(Math.sqrt(auto.length)))
    let slot = 0
    function nextSlot() {
        const anchor = { col: 3 + (slot % columns) * 3, row: 3 + Math.floor(slot / columns) * 3 }
        slot++
        return anchor
    }
    for (const agent of auto) {
        let anchor = nextSlot()
        while (!vacant(positions, anchor)) anchor = nextSlot()
        positions.set(agent.id, anchor)
    }
    const bounds = { col_start: 1, row_start: 1, col_end: 3 * columns + 2, row_end: 5 }
    for (const anchor of positions.values()) {
        bounds.col_end = Math.max(bounds.col_end, anchor.col + DEFAULT_SPAN)
        bounds.row_end = Math.max(bounds.row_end, anchor.row + DEFAULT_SPAN)
    }

    const layout = { positions, bounds }
    for (let row = bounds.row_start; row < bounds.row_end; row++) {
        for (let col = bounds.col_start; col < bounds.col_end; col++) {
            const suggested = { col, row }
            if (canPlaceDesktopCopy(layout, suggested)) return { ...layout, suggested }
        }
    }
    // A densely filled team gets another strip so Duplicate always has a valid destination.
    const suggested = { col: 3, row: bounds.row_end + 1 }
    bounds.row_end = suggested.row + DEFAULT_SPAN
    return { ...layout, suggested }
}
