'use client'

import { useCallback, useRef, useState, type RefObject } from 'react'

export type DesktopDialogControl = { open: boolean; onOpenChange: (open: boolean) => void }

/** Keep each dialog's existing guarded close path, with optional navigation-owned state. */
export function useDesktopDialogControl(control?: DesktopDialogControl) {
    const [localOpen, setLocalOpen] = useState(false)
    return [control?.open ?? localOpen, control?.onOpenChange ?? setLocalOpen] as const
}

export type DesktopPanelCloseGuard = (close: () => void) => void
export type RegisterDesktopPanelCloseGuard = (guard: DesktopPanelCloseGuard) => () => void

export function useDesktopPanelCloseGuard(shared?: RefObject<DesktopPanelCloseGuard | null>) {
    const local = useRef<DesktopPanelCloseGuard | null>(null)
    const ref = shared ?? local
    const register = useCallback<RegisterDesktopPanelCloseGuard>(guard => {
        ref.current = guard
        return () => { if (ref.current === guard) ref.current = null }
    }, [ref])
    const requestClose = useCallback((close: () => void) => {
        const guard = ref.current
        if (guard) guard(close)
        else close()
    }, [ref])
    return { ref, register, requestClose }
}
