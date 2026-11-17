export type PageAttention = 'focused' | 'visible' | 'hidden'

// Whether someone is looking at the Mac app. Its window is throttled when hidden, so the document's
// own visibility answers; upstream's desktop shell needs its window state instead
// (apps/ui/lib/desktop-shell/attention.ts there).
const listeners = new Set<() => void>()

function notify(): void {
    for (const listener of [...listeners]) listener()
}

// `focused`: the person is in the app. `visible`: it is on screen behind another one. `hidden`:
// minimized, covered, or on another Space.
export function pageAttention(): PageAttention {
    if (typeof document === 'undefined') return 'hidden'
    if (document.visibilityState !== 'visible') return 'hidden'
    return document.hasFocus() ? 'focused' : 'visible'
}

// Called on every change of `pageAttention()`, for `useSyncExternalStore`.
export function subscribePageAttention(listener: () => void): () => void {
    if (listeners.size === 0) {
        document.addEventListener('visibilitychange', notify)
        window.addEventListener('focus', notify)
        window.addEventListener('blur', notify)
    }
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        document.removeEventListener('visibilitychange', notify)
        window.removeEventListener('focus', notify)
        window.removeEventListener('blur', notify)
    }
}
