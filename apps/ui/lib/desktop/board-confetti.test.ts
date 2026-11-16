// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest'

const confetti = vi.hoisted(() => {
    const burst = Object.assign(vi.fn(async () => undefined), { reset: vi.fn() })
    return { burst, create: vi.fn(() => burst) }
})
vi.mock('canvas-confetti', () => ({ default: { create: confetti.create } }))
import { fireBoardConfetti } from './board-confetti'

const reduce = (matches: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query.includes('reduce'), addEventListener() {}, removeEventListener() {} }))
const board = () => document.body.appendChild(document.createElement('section'))
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

test('one burst plays on a canvas inside the board that takes no clicks and is removed afterwards', async () => {
    reduce(false)
    const section = board()
    let during: HTMLCanvasElement | null = null
    confetti.burst.mockImplementationOnce(async () => { during = section.querySelector('canvas'); return undefined })
    expect(await fireBoardConfetti(section)).toBe(true)
    expect(confetti.create).toHaveBeenCalledTimes(1)
    expect(confetti.burst).toHaveBeenCalledTimes(1)
    expect(during!.style.pointerEvents).toBe('none')
    expect(during!.getAttribute('aria-hidden')).toBe('true')
    expect(section.querySelector('canvas')).toBeNull()
    expect(confetti.burst.reset).toHaveBeenCalled()
})

test('nothing plays with Reduce motion on, while the window is hidden, or without a board', async () => {
    reduce(true)
    expect(await fireBoardConfetti(board())).toBe(false)
    reduce(false)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    expect(await fireBoardConfetti(board())).toBe(false)
    expect(await fireBoardConfetti(null)).toBe(false)
    expect(confetti.create).not.toHaveBeenCalled()
    expect(document.querySelector('canvas')).toBeNull()
})

test('a second burst does not start while one is in the air, and a failed one leaves nothing behind', async () => {
    reduce(false)
    const section = board()
    let land!: () => void
    confetti.burst.mockImplementationOnce(() => new Promise<undefined>(resolve => { land = () => resolve(undefined) }))
    const first = fireBoardConfetti(section)
    await vi.waitFor(() => expect(confetti.burst).toHaveBeenCalledTimes(1))
    expect(await fireBoardConfetti(section)).toBe(false)
    land()
    expect(await first).toBe(true)
    confetti.burst.mockImplementationOnce(async () => { throw new Error('no canvas') })
    expect(await fireBoardConfetti(section)).toBe(false)
    expect(section.querySelector('canvas')).toBeNull()
    expect(await fireBoardConfetti(section)).toBe(true)
})
