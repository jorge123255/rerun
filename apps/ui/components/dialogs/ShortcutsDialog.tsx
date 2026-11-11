'use client'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useModKeyLabel } from '@/hooks/useModKeyLabel'
import { useShortcutsStore } from '@/stores/shortcuts.store'

type Shortcut = { keys: string[]; action: string }
export type ShortcutGroup = { title: string; shortcuts: Shortcut[] }

function buildGroups(mod: string): ShortcutGroup[] {
    return [
        {
            title: 'General',
            shortcuts: [
                { keys: [mod, 'F'], action: 'Open the control center' },
                { keys: [mod, 'K'], action: 'Ask Rerun, outside a chat' },
                { keys: ['Space'], action: 'Hold to talk to Rerun' },
                { keys: [mod, 'F', '×2'], action: 'Search in the page' },
            ],
        },
        {
            title: 'Chat',
            shortcuts: [
                { keys: [mod, 'K'], action: 'New conversation' },
                { keys: [mod, '⌫'], action: 'Close active tab' },
                { keys: ['Enter'], action: 'Send message' },
                { keys: ['Shift', 'Enter'], action: 'New line' },
            ],
        },
        {
            title: 'Files',
            shortcuts: [
                { keys: ['←'], action: 'Previous file' },
                { keys: ['→'], action: 'Next file' },
            ],
        },
    ]
}

export function ShortcutsDialog() {
    const { open, setOpen } = useShortcutsStore()
    const mod = useModKeyLabel()

    return <ShortcutsDialogView open={open} onOpenChange={setOpen} groups={buildGroups(mod)} />
}

// The desktop reuses the original view with only the shortcuts its local runtime supports.
export function ShortcutsDialogView({ open, onOpenChange, groups, onCloseAutoFocus, title = 'Keyboard shortcuts',
    description = 'Move faster around Rerun with these shortcuts.', closeLabel }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    groups: ShortcutGroup[]
    onCloseAutoFocus?: (event: Event) => void
    title?: string
    description?: string
    closeLabel?: string
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus} closeLabel={closeLabel}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-5 py-2">
                    {groups.map(group => (
                        <div key={group.title} className="flex flex-col gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</span>
                            <div className="flex flex-col gap-1.5">
                                {group.shortcuts.map((sc, i) => (
                                    <div key={i} className="flex items-center justify-between gap-4">
                                        <span className="text-sm text-foreground">{sc.action}</span>
                                        <span className="flex items-center gap-1">
                                            {sc.keys.map((k, j) => (
                                                <Kbd key={j}>{k}</Kbd>
                                            ))}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}
