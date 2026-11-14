'use client'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { KeyIcon } from '@/lib/icons'
import type { DesktopClaudePlanRuntime } from '@/lib/desktop/claude-plan-client/use-desktop-claude-plan'
import { DesktopClaudePlanSteps } from './DesktopClaudePlanSteps'

export function DesktopClaudePlanDialog({ open, onOpenChange, runtime, onOpenAuthorization, onDone }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    runtime: DesktopClaudePlanRuntime
    onOpenAuthorization: (url: string) => void
    onDone: (name: string) => void | Promise<void>
}) {
    // Steps owns its captured attempt; unmount cancels that exact attempt only.
    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85dvh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-lg">
            <DialogHeaderBar icon={KeyIcon} title="Connect Claude" description="Use your Claude subscription. The code is checked only by the desktop sign-in runtime." />
            <DesktopClaudePlanSteps runtime={runtime} onOpenAuthorization={onOpenAuthorization} onDone={async name => { await onDone(name); onOpenChange(false) }} />
        </DialogContent>
    </Dialog>
}
