// The timing of what arrives on the Team board. Pure, so the cap can be tested without a board.

/** How far apart coworkers drop in when several arrive together. */
export const BOARD_DROP_STAGGER_MS = 100
/** The last coworker of a group starts falling at most this long after the group arrived. */
export const BOARD_DROP_SPREAD_MS = 500
/** The grid's own drop-in (`agent-drop-in` in the iso-grid styles). */
export const BOARD_DROP_MS = 1000
/** The grid's own Box entrance, drawn outline first. */
export const BOARD_BOX_DRAW_MS = 380
const BOARD_BOX_STAGGER_MS = 60
const BOARD_BOX_SPREAD_MS = 180
/** New Boxes get this head start, so coworkers land in a Box that is already being drawn. */
export const BOARD_BOX_LEAD_MS = 150
/** The longest a whole arrival takes, however large the team. */
export const BOARD_ENTRANCE_MAX_MS = BOARD_DROP_SPREAD_MS + BOARD_DROP_MS
/** How long a coworker's one bounce is held when its run finishes (the grid's bounce is 560 ms). */
export const BOARD_BOUNCE_MS = 700
/** A finished team build celebrates coworkers that arrived this recently, and no older ones. */
export const BOARD_CELEBRATE_WINDOW_MS = 15_000

function spread(count: number, stagger: number, cap: number, lead = 0): number[] {
    if (count <= 0) return []
    const step = count > 1 ? Math.min(stagger, Math.max(0, cap - lead) / (count - 1)) : 0
    return Array.from({ length: count }, (_, index) => Math.round(lead + index * step))
}

export type BoardEntrancePlan = {
    /** Delay before each new Box starts drawing, by id. */
    boxes: Map<string, number>
    /** Delay before each new coworker starts falling, by id. */
    tiles: Map<string, number>
    /** When the last of them has landed, in ms from the arrival. */
    endsAt: number
}

/**
 * New Boxes draw in first, then the new coworkers drop in one after another: 100 ms apart for a
 * small group, closer together for a large one so that the whole arrival still ends within
 * `BOARD_ENTRANCE_MAX_MS`.
 */
export function boardEntrancePlan(newBoxIds: readonly string[], newTileIds: readonly string[]): BoardEntrancePlan {
    const boxDelays = spread(newBoxIds.length, BOARD_BOX_STAGGER_MS, BOARD_BOX_SPREAD_MS)
    const tileDelays = spread(newTileIds.length, BOARD_DROP_STAGGER_MS, BOARD_DROP_SPREAD_MS, newBoxIds.length ? BOARD_BOX_LEAD_MS : 0)
    const boxesEnd = boxDelays.length ? boxDelays[boxDelays.length - 1] + BOARD_BOX_DRAW_MS : 0
    const tilesEnd = tileDelays.length ? tileDelays[tileDelays.length - 1] + BOARD_DROP_MS : 0
    return {
        boxes: new Map(newBoxIds.map((id, index) => [id, boxDelays[index]])),
        tiles: new Map(newTileIds.map((id, index) => [id, tileDelays[index]])),
        endsAt: Math.max(boxesEnd, tilesEnd),
    }
}
