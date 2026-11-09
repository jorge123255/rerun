'use client'

import { useRef, useSyncExternalStore } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BookOpenIcon, HandshakeIcon, KeyboardIcon, ListChecksIcon, UsersIcon } from '@/lib/icons'
import { desktopGettingStartedAvailable, subscribeDesktopGettingStartedAvailability } from '@/lib/desktop/help/availability'
import { desktopHelpEntries, desktopHelpKeepsFocus, type DesktopHelpEntry } from '@/lib/desktop/help/entries'

const ICONS = {
    getting_started: ListChecksIcon,
    docs: BookOpenIcon,
    community: UsersIcon,
    shortcuts: KeyboardIcon,
    experts: HandshakeIcon,
} as const

type DesktopHelpDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: number | null
    onGettingStarted?: () => void
    onShortcuts?: () => void
    onCloseAutoFocus?: (event: Event) => void
}

/** Local help. Docs use the approved docs origin. Shortcuts opens the Mac dialog. No hosted feed or support chat. */
export function DesktopHelpDialog({ open, onOpenChange, workspaceId, onGettingStarted, onShortcuts, onCloseAutoFocus }: DesktopHelpDialogProps) {
    const gettingStarted = useSyncExternalStore(
        subscribeDesktopGettingStartedAvailability,
        () => desktopGettingStartedAvailable(workspaceId),
        () => false,
    )
    const intent = useRef<DesktopHelpEntry['kind'] | 'close'>('close')
    const entries = desktopHelpEntries({ gettingStarted: gettingStarted && !!onGettingStarted, shortcuts: !!onShortcuts })
    const rowClass = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground'

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-md"
                onCloseAutoFocus={event => {
                    const keep = desktopHelpKeepsFocus(intent.current)
                    intent.current = 'close'
                    if (keep) {
                        event.preventDefault()
                        return
                    }
                    onCloseAutoFocus?.(event)
                }}
            >
                <DialogHeader>
                    <DialogTitle>Help</DialogTitle>
                    <DialogDescription>Docs and shortcuts for this Mac. Getting started stays here after you hide the checklist.</DialogDescription>
                </DialogHeader>
                <ul className="flex flex-col py-1">
                    {entries.map(entry => {
                        const Icon = ICONS[entry.id]
                        if (entry.kind === 'link') {
                            return (
                                <li key={entry.id}>
                                    <a href={entry.href} target="_blank" rel="noopener noreferrer" className={rowClass}>
                                        <Icon className="size-4" />
                                        {entry.label}
                                    </a>
                                </li>
                            )
                        }
                        return (
                            <li key={entry.id}>
                                <button
                                    type="button"
                                    className={rowClass}
                                    onClick={() => {
                                        intent.current = entry.kind
                                        onOpenChange(false)
                                        if (entry.kind === 'getting_started') onGettingStarted?.()
                                        else onShortcuts?.()
                                    }}
                                >
                                    <Icon className="size-4" />
                                    {entry.label}
                                </button>
                            </li>
                        )
                    })}
                </ul>
            </DialogContent>
        </Dialog>
    )
}
