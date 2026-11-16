import { expect, test } from 'vitest'
import { BOARD_BOX_LEAD_MS, BOARD_DROP_MS, BOARD_DROP_SPREAD_MS, BOARD_ENTRANCE_MAX_MS, boardEntrancePlan } from './board-motion'

const ids = (count: number, prefix = 'c') => Array.from({ length: count }, (_, index) => `${prefix}${index}`)

test('a small group drops in one after another, 100 ms apart', () => {
    const plan = boardEntrancePlan([], ids(4))
    expect([...plan.tiles.values()]).toEqual([0, 100, 200, 300])
    expect(plan.endsAt).toBe(300 + BOARD_DROP_MS)
    expect(boardEntrancePlan([], ['only']).tiles.get('only')).toBe(0)
})

test('a large team closes the gaps so the whole arrival still ends within a second and a half', () => {
    for (const count of [7, 12, 40, 200]) {
        const plan = boardEntrancePlan(ids(3, 'b'), ids(count))
        const delays = [...plan.tiles.values()]
        expect(delays).toEqual([...delays].sort((a, b) => a - b))
        expect(Math.max(...delays)).toBeLessThanOrEqual(BOARD_DROP_SPREAD_MS)
        expect(plan.endsAt).toBeLessThanOrEqual(BOARD_ENTRANCE_MAX_MS)
        expect(BOARD_ENTRANCE_MAX_MS).toBe(1500)
    }
})

test('new Boxes start drawing first and the coworkers follow them in', () => {
    const plan = boardEntrancePlan(['b0', 'b1'], ids(3))
    expect([...plan.boxes.values()]).toEqual([0, 60])
    expect([...plan.tiles.values()]).toEqual([BOARD_BOX_LEAD_MS, BOARD_BOX_LEAD_MS + 100, BOARD_BOX_LEAD_MS + 200])
    expect(boardEntrancePlan(['b0'], []).endsAt).toBe(380)
    expect(boardEntrancePlan([], [])).toEqual({ boxes: new Map(), tiles: new Map(), endsAt: 0 })
})
