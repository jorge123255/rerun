'use client'

import { useCallback, useRef, useState } from 'react'

export type DesktopDialogControl = { open: boolean; onOpenChange: (open: boolean) => void }

/** Keep each dialog's existing guarded close path, with optional navigation-owned state. */
export function useDesktopDialogControl(control?: DesktopDialogControl) {
    const [localOpen, setLocalOpen] = useState(false)
    return [control?.open ?? localOpen, control?.onOpenChange ?? setLocalOpen] as const
}

export type DesktopPanelCloseGuard = (close: () => void) => void
export type RegisterDesktopPanelCloseGuard = (guard: DesktopPanelCloseGuard) => () => void

export type DesktopPanelCloseControl = {
    register: RegisterDesktopPanelCloseGuard
    requestClose: (close: () => void) => void
}

export function useDesktopPanelCloseGuard(): DesktopPanelCloseControl {
    const ref = useRef<DesktopPanelCloseGuard | null>(null)
    const register = useCallback<RegisterDesktopPanelCloseGuard>(guard => {
        ref.current = guard
        return () => { if (ref.current === guard) ref.current = null }
    }, [])
    const requestClose = useCallback((close: () => void) => {
        const guard = ref.current
        if (guard) guard(close)
        else close()
    }, [])
    return { register, requestClose }
}
