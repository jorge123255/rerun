import { describe, expect, it } from 'vitest'
import { boundedPlacement, dropPlacement, settleSheet } from './layout'
import { DEFAULT_FOREMAN_PLACEMENT } from '@/lib/foreman-layout'

describe('original Foreman layout on resized screens', () => {
    it('retains original left/right edge snap and floating quadrant semantics', () => {
        const args = { x: 500, y: 500 }, viewport = { width: 1200, height: 900 }
        expect(dropPlacement({ x: 79, y: 100 }, args, DEFAULT_FOREMAN_PLACEMENT, viewport)).toMatchObject({ mode: 'dock', side: 'left' })
        expect(dropPlacement({ x: 1121, y: 100 }, args, DEFAULT_FOREMAN_PLACEMENT, viewport)).toMatchObject({ mode: 'dock', side: 'right' })
        expect(dropPlacement({ x: 500, y: 100 }, args, DEFAULT_FOREMAN_PLACEMENT, viewport)).toMatchObject({ mode: 'float', corner: 'bottom-left' })
    })
    it('bounds restored huge windows without rewriting the saved preferred geometry', () => {
        const saved = { ...DEFAULT_FOREMAN_PLACEMENT, width: 4000, height: 4000 }
        const result = boundedPlacement(saved, { width: 375, height: 320 })
        expect(result.width).toBeLessThanOrEqual(343)
        expect(result.height).toBeLessThanOrEqual(288)
        expect(saved.width).toBe(4000)
        expect(boundedPlacement(saved, { width: 1440, height: 1000 }).height).toBeGreaterThan(result.height)
    })
    it('keeps dock within original sixty percent maximum and handles minimized zero sizes', () => {
        expect(boundedPlacement({ ...DEFAULT_FOREMAN_PLACEMENT, dockWidth: 800 }, { width: 1000, height: 700 }).dockWidth).toBe(600)
        expect(boundedPlacement(DEFAULT_FOREMAN_PLACEMENT, { width: 0, height: 0 })).toMatchObject({ width: 1, height: 1, dockWidth: 1 })
    })
    it('only dismisses below the medium floor; a throw from large settles to medium', () => {
        expect(settleSheet(700, 100, 1, 800)).toBe('medium')
        expect(settleSheet(400, 150, 0, 800)).toBe('dismiss')
    })
})
it('keeps persisted sizes valid independently from a one-pixel minimized presentation', async () => {
    const { savedPlacement } = await import('./layout')
    const view = boundedPlacement(DEFAULT_FOREMAN_PLACEMENT, { width: 0, height: 0 })
    expect(savedPlacement(view)).toMatchObject({ width: 100, height: 100, dockWidth: 100 })
})
