'use client'

import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { LockIcon } from '@/lib/icons'
import type { DesktopTriggerTemplateLockState } from '@/lib/desktop/triggers'
import type { ReactNode } from 'react'

/** Original TemplateContentLock appearance; unlock is injected (no hosted billing store import). */
export function DesktopTriggerTemplateLock({
    state,
    children,
}: {
    state: DesktopTriggerTemplateLockState
    children: ReactNode
}) {
    if (!state.locked) return <>{children}</>

    return (
        <div className="relative isolate">
            <div aria-hidden className="pointer-events-none select-none blur-[3px] opacity-70">
                {children}
            </div>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon size="lg" icon={LockIcon} className="text-muted-foreground" />
                <div className="space-y-1.5">
                    <p className="text-sm font-medium">Locked while template content is sealed</p>
                    <p className="text-xs text-muted-foreground">
                        This coworker came from a template. Its {state.subject} stay sealed until unlock is available.
                    </p>
                </div>
                {state.onUnlock ? (
                    <Button size="sm" variant="outline" highlight onClick={state.onUnlock}>
                        {state.unlockLabel ?? 'Unlock'}
                    </Button>
                ) : (
                    <p className="text-xs text-muted-foreground">Unlock is unavailable in this desktop build until root wires plan status.</p>
                )}
            </div>
        </div>
    )
}
