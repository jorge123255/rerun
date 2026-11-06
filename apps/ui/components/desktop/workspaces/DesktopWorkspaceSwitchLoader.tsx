'use client'

import { AppLoader } from '@/components/layout/AppLoader'
import { useDesktopWorkspaceSwitchLoader } from '@/lib/desktop/workspaces'

/** Original WorkspaceSwitchLoader: covers the hard navigation between workspaces. */
export function DesktopWorkspaceSwitchLoader() {
    const visible = useDesktopWorkspaceSwitchLoader()
    if (!visible) return null
    return <AppLoader className="fixed inset-0 z-[100] h-auto animate-in fade-in-0 duration-200 motion-reduce:animate-none" />
}
