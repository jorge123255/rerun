import { liftedBy, stretchedFrom } from '@/components/buddy/wall-motion'

function applied([a, b, c, d, e, f]: number[], x: number, y: number) {
    return { x: a * x + c * y + e, y: b * x + d * y + f }
}

describe('wall motion', () => {
    it('leaves the walls alone at rest', () => {
        expect(stretchedFrom(10, 1)).toEqual([1, 0, 0, 1, 0, 0])
        expect(liftedBy(0)).toEqual([1, 0, 0, 1, 0, 0])
    })

    it('grows the walls from their floor line', () => {
        const matrix = stretchedFrom(10, 1.2)
        expect(applied(matrix, 3, 10).y).toBeCloseTo(10)
        expect(applied(matrix, 3, 0).y).toBeCloseTo(-2)
        expect(applied(matrix, 3, 0).x).toBe(3)
    })

    it('lifts the top by as much as the walls grew', () => {
        const depth = 20
        const stretch = 1.2
        expect(applied(liftedBy((1 - stretch) * depth), 0, 5).y).toBeCloseTo(1)
    })
})
