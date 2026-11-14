'use client'

import { useRef, useSyncExternalStore } from 'react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { BookOpenIcon, HandshakeIcon, KeyboardIcon, ListChecksIcon, MegaphoneIcon, UsersIcon, HelpCircleIcon } from '@/lib/icons'
import { desktopGettingStartedAvailable, subscribeDesktopGettingStartedAvailability } from '@/lib/desktop/help/availability'
import { desktopHelpEntries, desktopHelpKeepsFocus, type DesktopHelpEntry } from '@/lib/desktop/help/entries'
import { useDesktopLocale } from '../DesktopLocale'

const ICONS = {
    getting_started: ListChecksIcon,
    whats_new: MegaphoneIcon,
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
    onChangelog?: () => void
    onCloseAutoFocus?: (event: Event) => void
}

export function DesktopHelpDialog({ open, onOpenChange, workspaceId, onGettingStarted, onShortcuts, onChangelog, onCloseAutoFocus }: DesktopHelpDialogProps) {
    const { t } = useDesktopLocale()
    const gettingStarted = useSyncExternalStore(
        subscribeDesktopGettingStartedAvailability,
        () => desktopGettingStartedAvailable(workspaceId),
        () => false,
    )
    const intent = useRef<DesktopHelpEntry['kind'] | 'close'>('close')
    const entries = desktopHelpEntries({ gettingStarted: gettingStarted && !!onGettingStarted, shortcuts: !!onShortcuts, changelog: !!onChangelog })
    const rowClass = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground'

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-md"
                closeLabel={t('closeDialog')}
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
                <DialogHeaderBar icon={HelpCircleIcon} title={t('help')} description={t('helpDescription')} />
                <ul className="flex flex-col py-1">
                    {entries.map(entry => {
                        const Icon = ICONS[entry.id]
                        if (entry.kind === 'link') {
                            return (
                                <li key={entry.id}>
                                    <a href={entry.href} target="_blank" rel="noopener noreferrer" className={rowClass}>
                                        <Icon className="size-4" />
                                        {t(`helpItems.${entry.id}`)}
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
                                        else if (entry.kind === 'whats_new') onChangelog?.()
                                        else onShortcuts?.()
                                    }}
                                >
                                    <Icon className="size-4" />
                                    {t(`helpItems.${entry.id}`)}
                                </button>
                            </li>
                        )
                    })}
                </ul>
            </DialogContent>
        </Dialog>
    )
}
