import { hideWorkspaceWindow, revealWorkspaceWindow } from './window-visibility.mjs'

/** How long the window being shown takes to fade in over the one being left. */
export const WORKSPACE_SWAP_FADE_MS = 150
const FADE_STEP_MS = 16

// The fade in flight for a window, whichever side of the swap it is on. Finishing it puts the shown
// window at full opacity and hides the one being left, so a second swap never starts from a
// half-transparent window.
const fades = new WeakMap()

/**
 * True when the Mac asks for less motion. Either Electron reading is enough; one that cannot be
 * read counts as "reduce", because an instant swap is always safe.
 */
export function prefersReducedMotion({ nativeTheme, systemPreferences } = {}) {
    try {
        if (nativeTheme?.prefersReducedMotion === true) return true
        return systemPreferences?.getAnimationSettings?.()?.prefersReducedMotion === true
    } catch {
        return true
    }
}

function opaque(window) {
    try { if (window && !window.isDestroyed() && typeof window.setOpacity === 'function') window.setOpacity(1) } catch { /* Nothing more can be done for this window. */ }
}

/**
 * One workspace on screen at a time. The window being shown takes the place of the one being left
 * (same position and size), and the one being left is hidden, not closed: its workspace keeps
 * running, so coworkers and routines on it carry on. A full-screen window keeps its own Space.
 *
 * With `fade`, the window being shown fades in over the one being left, which is hidden once the
 * fade ends. Without it (the default, and what Reduce motion asks for) the swap is instant. A fade
 * that fails, or loses either window on the way, ends with the shown window at full opacity.
 */
export function swapWorkspaceWindow(leaving, showing, { fade = false, durationMs = WORKSPACE_SWAP_FADE_MS, timers = globalThis } = {}) {
    if (!showing || showing.isDestroyed()) return false
    // A swap that starts during a fade settles that fade first.
    fades.get(showing)?.()
    if (leaving) fades.get(leaving)?.()
    if (showing.isDestroyed()) return false
    const leave = leaving && !leaving.isDestroyed() && leaving !== showing ? leaving : null
    const inPlace = !!leave && !leave.isFullScreen() && !showing.isFullScreen() && !leave.isMinimized()
    if (inPlace) showing.setBounds(leave.getBounds())
    // A fade needs both windows in the same place, and a window that is not on screen yet: one
    // already showing would have to blink out first.
    if (!fade || !inPlace || !(durationMs > 0) || typeof showing.setOpacity !== 'function' || showing.isVisible?.()) {
        revealWorkspaceWindow(showing)
        if (leave) hideWorkspaceWindow(leave)
        return true
    }

    const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS))
    let timer
    let done = false
    const finish = () => {
        if (done) return
        done = true
        if (timer !== undefined) timers.clearInterval(timer)
        fades.delete(showing)
        fades.delete(leave)
        opaque(showing)
        // The window being left stays when the one meant to replace it is gone: something must show.
        try { if (!showing.isDestroyed() && !leave.isDestroyed()) hideWorkspaceWindow(leave) } catch { /* It stays visible behind the shown window. */ }
    }
    fades.set(showing, finish)
    fades.set(leave, finish)
    try {
        showing.setOpacity(0)
        revealWorkspaceWindow(showing)
        let step = 0
        timer = timers.setInterval(() => {
            try {
                step += 1
                if (step >= steps || showing.isDestroyed() || leave.isDestroyed()) { finish(); return }
                // Ease out: most of the change lands early, so the swap reads as quick.
                showing.setOpacity(1 - (1 - step / steps) ** 2)
            } catch {
                finish()
            }
        }, FADE_STEP_MS)
        timer?.unref?.()
    } catch {
        // Whatever failed, the window still has to be on screen and opaque.
        try { if (!showing.isDestroyed()) revealWorkspaceWindow(showing) } catch { /* The window cannot be shown; it is at least not left transparent. */ }
        finish()
    }
    return true
}
