import type { CreateTypes } from 'canvas-confetti'

const COLORS = ['#f59e0b', '#06b6d4', '#4d34f7', '#b7a8ff', '#00b862', '#f0127f']
let firing = false

/**
 * One short burst of confetti over the Team board, for a team that has just been placed. It is
 * drawn on its own canvas inside the board, which takes no clicks and is removed when the burst
 * ends. Nothing plays with Reduce motion on, while the window is hidden, or while a burst is
 * already in the air.
 */
export async function fireBoardConfetti(board: HTMLElement | null): Promise<boolean> {
    if (!board || firing || typeof window === 'undefined') return false
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.visibilityState === 'hidden') return false
    firing = true
    let canvas: HTMLCanvasElement | null = null
    let burst: CreateTypes | null = null
    try {
        // `create` is only on the default export of canvas-confetti's ESM build.
        const { default: confetti } = await import('canvas-confetti')
        if (!board.isConnected) return false
        canvas = document.createElement('canvas')
        canvas.setAttribute('aria-hidden', 'true')
        canvas.dataset.boardConfetti = ''
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:30'
        board.appendChild(canvas)
        burst = confetti.create(canvas, { resize: true, disableForReducedMotion: true })
        await burst({ particleCount: 90, spread: 80, startVelocity: 34, gravity: 1.1, ticks: 110, scalar: 0.9, origin: { x: 0.5, y: 0.55 }, colors: COLORS })
        return true
    } catch {
        return false
    } finally {
        burst?.reset()
        canvas?.remove()
        firing = false
    }
}
