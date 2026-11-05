import { describe, expect, it } from 'vitest'
import { HUMAN_DRIVING, KEY_MAX, SETTLE_MS, TYPE_MAX, keyCombos, planAction, viewOf } from './input.js'
import type { ScreenComputerInput } from './types.js'
import { IsolatedScreenRefusal } from './refusal.js'

const screen = viewOf(1920, 1080)

describe('screen geometry', () => {
    it('uses the original screenshot scale', () => {
        expect(screen).toMatchObject({ width: 1920, height: 1080, scale: 1.5, viewWidth: 1280, viewHeight: 720 })
        expect(viewOf(1024, 600).scale).toBe(1)
        expect(viewOf(1280, 1440)).toMatchObject({ scale: 2, viewWidth: 640, viewHeight: 720 })
        expect(() => viewOf(0, 10)).toThrow(/did not report its size/)
        expect(() => viewOf(Number.POSITIVE_INFINITY, 10)).toThrow(IsolatedScreenRefusal)
    })
})

describe('computer actions', () => {
    it('maps screenshot pixels back onto the framebuffer', () => {
        const click = planAction({ action: 'left_click', coordinate: [10, 20] }, screen)
        expect(click.settleMs).toBe(SETTLE_MS)
        expect(click.calls).toEqual([{ kind: 'input', body: { op: 'input', action: 'click', button: 'left', x: 15, y: 30 } }])
        const edge = planAction({ action: 'mouse_move', coordinate: [10_000, -5] }, screen)
        expect(edge.calls[0]).toMatchObject({ body: { action: 'mousemove', x: 1919, y: 0 } })
        expect(planAction({ action: 'right_click', coordinate: [0, 0] }, screen).calls[0]).toMatchObject({ body: { button: 'right' } })
        expect(planAction({ action: 'double_click', coordinate: [0, 0] }, screen).calls[0]).toMatchObject({ body: { double: true, button: 'left' } })
        expect(planAction({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }, screen).calls[0]).toMatchObject({ body: { action: 'drag', x1: 2, y1: 3, x2: 5, y2: 6 } })
        expect(planAction({ action: 'scroll', coordinate: [0, 0], scroll_direction: 'down' }, screen).calls[0]).toMatchObject({ body: { action: 'scroll', direction: 'down', amount: 3 } })
    })

    it('chunks typing, validates keys, and does not settle a look or a wait', () => {
        expect(planAction({ action: 'screenshot' }, screen)).toEqual({ calls: [], settleMs: 0 })
        expect(planAction({ action: 'wait' }, screen)).toEqual({ calls: [{ kind: 'wait', ms: 1000 }], settleMs: 0 })
        expect(planAction({ action: 'wait', duration: 0 }, screen).calls).toEqual([{ kind: 'wait', ms: 0 }])
        const typed = planAction({ action: 'type', text: 'a'.repeat(41) }, screen)
        expect(typed.calls.map(call => (call.kind === 'input' ? call.body.text : ''))).toEqual(['a'.repeat(40), 'a'])
        expect(planAction({ action: 'key', text: 'ctrl+a' }, screen).calls[0]).toMatchObject({ body: { action: 'key', keys: 'ctrl+a' } })
        expect(keyCombos('ctrl+a enter f5')).toEqual(['ctrl+a', 'Return', 'F5'])
    })

    it('refuses an action the original computer tool would refuse', () => {
        expect(HUMAN_DRIVING).toContain('The user is driving your screen right now')
        expect(() => planAction({ action: 'left_click' }, screen)).toThrow('left_click needs coordinate.')
        expect(() => planAction({ action: 'left_click', coordinate: [Number.NaN, 0] }, screen)).toThrow(/off the screen/)
        expect(() => planAction({ action: 'left_click_drag', coordinate: [0, 0] }, screen)).toThrow('left_click_drag needs start_coordinate.')
        expect(() => planAction({ action: 'scroll', coordinate: [0, 0] }, screen)).toThrow('scroll needs scroll_direction.')
        expect(() => planAction({ action: 'scroll', coordinate: [0, 0], scroll_direction: 'up', scroll_amount: 0 }, screen)).toThrow(/scroll is not available/)
        expect(() => planAction({ action: 'scroll', coordinate: [0, 0], scroll_direction: 'up', scroll_amount: 3.5 }, screen)).toThrow(/scroll is not available/)
        expect(() => planAction({ action: 'type', text: '' }, screen)).toThrow('type needs text.')
        expect(() => planAction({ action: 'type', text: 'x'.repeat(TYPE_MAX + 1) }, screen)).toThrow(/too long/)
        expect(() => planAction({ action: 'key', text: '' }, screen)).toThrow(/Name the key/)
        expect(() => planAction({ action: 'key', text: 'x'.repeat(KEY_MAX + 1) }, screen)).toThrow(/Name the key/)
        expect(() => keyCombos('bad/key')).toThrow(/not a key/)
        expect(() => planAction({ action: 'wait', duration: 11 }, screen)).toThrow(/not available/)
        expect(() => planAction({ action: 'nope' } as ScreenComputerInput, screen)).toThrow(/not available/)
    })
})
