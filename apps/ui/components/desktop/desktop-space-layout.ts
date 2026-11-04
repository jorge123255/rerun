import { agentsOverlap, containerContainsTile, DEFAULT_SPAN } from '@rerun/ui/iso-grid'
import type { ContainerCellRect, GridPosition } from '@rerun/ui/iso-grid'
import { SPACE_GAP } from '@/lib/board/space-layout'
import { desktopSpaceRectSchema, type DesktopBoardState, type DesktopSpace } from '@/lib/desktop/spaces'

export const desktopSpaceLabel = (space: DesktopSpace, index: number, count: number) => `Box ${space.name}, ${index + 1} of ${count}`

export function desktopSpaceAt(board: DesktopBoardState, position: GridPosition, ignoreAgentId?: string): DesktopSpace | undefined {
    if (!Number.isSafeInteger(position.col) || !Number.isSafeInteger(position.row)) return
    const space = board.spaces.find(space => containerContainsTile(space, position, DEFAULT_SPAN))
    if (space && !board.placements.some(placed => placed.agentId !== ignoreAgentId && agentsOverlap(placed, position))) return space
}

// Only boundaries after occupied cells can introduce a new free anchor. This produces the first
// row-major position without iterating millions of empty grid cells in a large resized Box.
export function firstDesktopSpacePosition(board: DesktopBoardState, spaceId?: string, ignoreAgentId?: string): { position: GridPosition; spaceId: string } | undefined {
    for (const space of board.spaces.filter(space => !spaceId || space.id === spaceId)) {
        const occupied = board.placements.filter(placed => placed.agentId !== ignoreAgentId && placed.spaceId === space.id)
        const rows = [...new Set([space.row_start, ...occupied.map(placed => placed.row + DEFAULT_SPAN)])].sort((a, b) => a - b)
        const cols = [...new Set([space.col_start, ...occupied.map(placed => placed.col + DEFAULT_SPAN)])].sort((a, b) => a - b)
        for (const row of rows) for (const col of cols) {
            const position = { col, row }
            if (desktopSpaceAt(board, position, ignoreAgentId)?.id === space.id) return { position, spaceId: space.id }
        }
    }
}

export function desktopSpaceRectAllowed(board: DesktopBoardState, spaceId: string, rect: ContainerCellRect, moving: boolean): boolean {
    const source = board.spaces.find(space => space.id === spaceId)
    if (!source || !desktopSpaceRectSchema.safeParse(rect).success) return false
    if (moving && (source.col_end - source.col_start !== rect.col_end - rect.col_start || source.row_end - source.row_start !== rect.row_end - rect.row_start)) return false
    if (board.spaces.some(other => other.id !== spaceId && rect.col_start - SPACE_GAP <= other.col_end && other.col_start <= rect.col_end + SPACE_GAP && rect.row_start - SPACE_GAP <= other.row_end && other.row_start <= rect.row_end + SPACE_GAP)) return false
    return board.placements.filter(placed => placed.spaceId === spaceId).every(placed => containerContainsTile(rect, {
        col: placed.col + (moving ? rect.col_start - source.col_start : 0),
        row: placed.row + (moving ? rect.row_start - source.row_start : 0),
    }, DEFAULT_SPAN))
}

export function previewDesktopSpace(board: DesktopBoardState, spaceId: string, rect: ContainerCellRect, moving: boolean): DesktopBoardState {
    const source = board.spaces.find(space => space.id === spaceId)
    if (!source) return board
    return {
        ...board,
        spaces: board.spaces.map(space => space.id === spaceId ? { ...space, ...rect } : space),
        placements: moving ? board.placements.map(placed => placed.spaceId === spaceId ? {
            ...placed, col: placed.col + rect.col_start - source.col_start, row: placed.row + rect.row_start - source.row_start,
        } : placed) : board.placements,
    }
}
