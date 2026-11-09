const listeners = new Set<() => void>()

/** Root's Control Center command calls this. The mounted pill restores the checklist. */
export function requestDesktopGettingStartedReopen(): void {
    for (const listener of listeners) listener()
}

export function onDesktopGettingStartedReopen(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
