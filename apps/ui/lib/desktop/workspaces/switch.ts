'use client'

import { useSyncExternalStore } from 'react'

/**
 * Local port of apps/ui/lib/workspace/workspace-switch.ts.
 * Switching reloads the desktop shell so module caches and stores cannot keep the
 * previous workspace. Navigation goes to /desktop, not an arbitrary deep link.
 */
let switching = false
let loaderVisible = false
const listeners = new Set<() => void>()

function setState(nextSwitching: boolean, nextLoaderVisible: boolean) {
    switching = nextSwitching
    if (loaderVisible === nextLoaderVisible) {
        listeners.forEach(listener => listener())
        return
    }
    loaderVisible = nextLoaderVisible
    listeners.forEach(listener => listener())
}

export function beginDesktopWorkspaceSwitch({ loader = true }: { loader?: boolean } = {}) {
    setState(true, loader)
}

export function abortDesktopWorkspaceSwitch() {
    setState(false, false)
}

export function enterDesktopActiveWorkspace() {
    setState(true, true)
    if (typeof window !== 'undefined') window.location.assign('/desktop')
}

export function isDesktopWorkspaceSwitchInFlight() {
    return switching
}

function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function useDesktopWorkspaceSwitchLoader() {
    return useSyncExternalStore(subscribe, () => loaderVisible, () => false)
}
