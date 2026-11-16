import { hideWorkspaceWindow, revealWorkspaceWindow } from './window-visibility.mjs'

/**
 * One workspace on screen at a time. The window being shown takes the place of the one being left
 * (same position and size), and the one being left is hidden, not closed: its workspace keeps
 * running, so coworkers and routines on it carry on. A full-screen window keeps its own Space.
 */
export function swapWorkspaceWindow(leaving, showing) {
    if (!showing || showing.isDestroyed()) return false
    const leave = leaving && !leaving.isDestroyed() && leaving !== showing ? leaving : null
    if (leave && !leave.isFullScreen() && !showing.isFullScreen() && !leave.isMinimized()) showing.setBounds(leave.getBounds())
    revealWorkspaceWindow(showing)
    if (leave) hideWorkspaceWindow(leave)
    return true
}
