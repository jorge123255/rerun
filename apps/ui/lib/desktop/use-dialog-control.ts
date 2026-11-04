'use client'

import { useState } from 'react'

export type DesktopDialogControl = { open: boolean; onOpenChange: (open: boolean) => void }

/** Keep each dialog's existing guarded close path, with optional navigation-owned state. */
export function useDesktopDialogControl(control?: DesktopDialogControl) {
    const [localOpen, setLocalOpen] = useState(false)
    return [control?.open ?? localOpen, control?.onOpenChange ?? setLocalOpen] as const
}
