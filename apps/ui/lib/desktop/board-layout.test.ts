import { expect, it } from 'vitest'
import { agentsOverlap } from '@rerun/ui/iso-grid/iso'
import { canPlaceDesktopCopy, desktopBoardLayout } from './board-layout'

it('preserves the original desktop arrangement and does not move coworkers when a copy is placed', () => {
    const agents = ['A', 'B', 'C'].map(id => ({ id }))
    const board = desktopBoardLayout(agents)
    expect([...board.positions.values()]).toEqual([{ col: 3, row: 3 }, { col: 6, row: 3 }, { col: 3, row: 6 }])
    const copy = { id: 'copy', position: board.suggested }
    const restored = desktopBoardLayout([...agents, copy])
    for (const { id } of agents) expect(restored.positions.get(id)).toEqual(board.positions.get(id))
    expect(restored.positions.get(copy.id)).toEqual(copy.position)
    expect(canPlaceDesktopCopy(restored, copy.position)).toBe(false)
    expect(canPlaceDesktopCopy(restored, restored.suggested)).toBe(true)
})

it('uses the same full two-cell footprint as the original grid at edges and between tiles', () => {
    const board = desktopBoardLayout([{ id: 'A' }])
    expect(canPlaceDesktopCopy(board, { col: 2, row: 2 })).toBe(false)
    expect(canPlaceDesktopCopy(board, { col: 1, row: 1 })).toBe(true)
    for (const col of [0, -5, 1.5, NaN, Infinity, board.bounds.col_end]) {
        expect(canPlaceDesktopCopy(board, { col, row: 1 })).toBe(false)
    }
})

it('keeps placed copies fixed as new regular coworkers join and leaves an available destination', () => {
    const placed = { id: 'copy', position: { col: 6, row: 3 } }
    const others = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
    const board = desktopBoardLayout([others[0], placed, ...others.slice(1)])
    expect(board.positions.get('copy')).toEqual(placed.position)
    const all = [...board.positions.values()]
    for (const [index, anchor] of all.entries()) {
        expect(all.slice(index + 1).some(other => agentsOverlap(anchor, other))).toBe(false)
    }
    expect(canPlaceDesktopCopy(board, board.suggested)).toBe(true)
})
