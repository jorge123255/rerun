'use client'

import { useSyncExternalStore } from 'react'

// Whether the column on the right of the Simple view is wanted: a coworker's card, or the Chief of
// Staff's panel. Closed until the person opens it, whatever the window's width, and kept from one
// to the other (upstream #276, #317). Not saved: it starts closed each launch, as upstream does.
let wanted = false
const listeners = new Set<() => void>()

export function desktopDetailsWanted(): boolean {
    return wanted
}

export function setDesktopDetailsWanted(next: boolean): void {
    if (wanted === next) return
    wanted = next
    for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function useDesktopDetailsWanted(): boolean {
    return useSyncExternalStore(subscribe, desktopDetailsWanted, () => false)
}
