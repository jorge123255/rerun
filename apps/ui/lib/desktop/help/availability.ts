type Availability = { workspaceId: number }

let current: Availability | null = null
const listeners = new Set<() => void>()

/** The pill publishes the workspace whose checklist read succeeded, including after dismiss. Null means unknown. */
export function publishDesktopGettingStartedAvailability(workspaceId: number | null): void {
    const next = workspaceId === null ? null : { workspaceId }
    if (current?.workspaceId === next?.workspaceId) return
    current = next
    for (const listener of listeners) listener()
}

export function desktopGettingStartedAvailable(workspaceId: number | null): boolean {
    return workspaceId !== null && current?.workspaceId === workspaceId
}

export function subscribeDesktopGettingStartedAvailability(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}
