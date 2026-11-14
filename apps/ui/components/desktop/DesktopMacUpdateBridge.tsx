'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'

const TOAST_ID = 'desktop-mac-update'

export type MacUpdateState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'downloading' }
    | { status: 'ready'; version?: string }
    | { status: 'error'; message?: string }

type MacUpdates = {
    getState: () => Promise<MacUpdateState>
    check: () => Promise<MacUpdateState>
    onState: (listener: (state: MacUpdateState) => void) => () => void
    install: () => Promise<unknown> | unknown
}

export function desktopMacUpdates(): MacUpdates | null {
    if (typeof window === 'undefined') return null
    const updates = (window as Window & { desktopApp?: { updates?: MacUpdates } }).desktopApp?.updates
    if (!updates || typeof updates.getState !== 'function' || typeof updates.onState !== 'function' || typeof updates.install !== 'function') return null
    return updates
}

function showUpdate(updates: MacUpdates, state: MacUpdateState) {
    if (state.status === 'downloading') {
        toast.loading('Downloading update…', { id: TOAST_ID, duration: Infinity })
        return
    }
    if (state.status === 'ready') {
        const version = state.version ? ` ${state.version}` : ''
        toast(`Update${version} is ready to install.`, {
            id: TOAST_ID,
            duration: Infinity,
            action: { label: 'Restart', onClick: () => { void Promise.resolve(updates.install()).catch(() => {}) } },
        })
        return
    }
    if (state.status === 'idle' || state.status === 'error') toast.dismiss(TOAST_ID)
}

export function DesktopMacUpdateBridge() {
    useEffect(() => {
        const updates = desktopMacUpdates()
        if (!updates) return
        let live = true
        let received = false
        const stop = updates.onState(state => {
            received = true
            if (live) showUpdate(updates, state)
        })
        void updates.getState().then(state => {
            if (live && !received) showUpdate(updates, state)
        }).catch(() => {})
        return () => { live = false; stop() }
    }, [])
    return null
}
