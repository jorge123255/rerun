const pendingHides = new WeakMap()

export function hideWorkspaceWindow(window) {
    if (window.isDestroyed() || pendingHides.has(window)) return
    if (!window.isFullScreen()) {
        window.hide()
        return
    }
    // macOS cannot hide a fullscreen window until it leaves its fullscreen Space.
    const hide = () => {
        pendingHides.delete(window)
        if (!window.isDestroyed()) window.hide()
    }
    pendingHides.set(window, hide)
    window.once('leave-full-screen', hide)
    window.setFullScreen(false)
}

export function revealWorkspaceWindow(window) {
    if (!window || window.isDestroyed()) return
    const pending = pendingHides.get(window)
    if (pending) {
        window.removeListener('leave-full-screen', pending)
        pendingHides.delete(window)
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
}
