'use client'

import { ShortcutsDialogView, type ShortcutGroup } from '@/components/dialogs/ShortcutsDialog'
import { useModKeyLabel } from '@/hooks/useModKeyLabel'

export function DesktopShortcutsDialog({ open, onOpenChange, onCloseAutoFocus }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCloseAutoFocus?: (event: Event) => void
}) {
    const mod = useModKeyLabel()
    const groups: ShortcutGroup[] = [
        { title: 'General', shortcuts: [
            { keys: [mod, 'F'], action: 'Open the control center' },
            { keys: [mod, 'K'], action: 'Open the control center, outside a chat or text field' },
        ] },
        { title: 'Chat', shortcuts: [
            { keys: [mod, 'K'], action: 'New conversation' },
            { keys: [mod, '⌫'], action: 'Close active tab, outside a text field' },
            { keys: ['Enter'], action: 'Send message' },
            { keys: ['Shift', 'Enter'], action: 'New line' },
        ] },
    ]
    return <ShortcutsDialogView open={open} onOpenChange={onOpenChange} groups={groups} onCloseAutoFocus={onCloseAutoFocus} />
}
