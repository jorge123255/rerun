// Connection deletion must not race any workspace preparation or background work.
// Unknown work stays protected even before a provider/connection has been resolved.
const work = new Set<symbol>()
let removal: symbol | null = null

export function beginDesktopApiConnectionWork(): (() => void) | null {
    if (removal) return null
    const token = Symbol('desktop-connection-work')
    work.add(token)
    return () => { work.delete(token) }
}

export function desktopApiConnectionRemovalAvailable(): boolean {
    return removal === null && work.size === 0
}

export function beginDesktopApiConnectionRemoval(): (() => void) | null {
    if (!desktopApiConnectionRemovalAvailable()) return null
    const token = Symbol('desktop-connection-removal')
    removal = token
    return () => { if (removal === token) removal = null }
}
