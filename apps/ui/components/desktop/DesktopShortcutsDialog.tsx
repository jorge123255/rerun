'use client'

import { ShortcutsDialogView, type ShortcutGroup } from '@/components/dialogs/ShortcutsDialog'
import { useModKeyLabel } from '@/hooks/useModKeyLabel'
import { useDesktopLocale } from './DesktopLocale'

export function DesktopShortcutsDialog({ open, onOpenChange, onCloseAutoFocus }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCloseAutoFocus?: (event: Event) => void
}) {
    const mod = useModKeyLabel()
    const { t } = useDesktopLocale()
    const groups: ShortcutGroup[] = [
        { title: t('shortcutDialog.groups.general'), shortcuts: [
            { keys: [mod, 'F'], action: t('shortcutDialog.actions.controlCenter') },
            { keys: [mod, 'K'], action: t('controlCenterOutsideInput') },
        ] },
        { title: t('shortcutDialog.groups.chat'), shortcuts: [
            { keys: [mod, 'K'], action: t('shortcutDialog.actions.newConversation') },
            { keys: [mod, '⌫'], action: t('closeTabOutsideInput') },
            { keys: ['Enter'], action: t('shortcutDialog.actions.sendMessage') },
            { keys: ['Shift', 'Enter'], action: t('shortcutDialog.actions.newLine') },
        ] },
        { title: t('shortcutDialog.groups.files'), shortcuts: [
            { keys: ['←'], action: t('shortcutDialog.actions.previousFile') },
            { keys: ['→'], action: t('shortcutDialog.actions.nextFile') },
        ] },
    ]
    return <ShortcutsDialogView open={open} onOpenChange={onOpenChange} groups={groups} onCloseAutoFocus={onCloseAutoFocus}
        title={t('shortcutDialog.title')} description={t('shortcutDialog.description')} closeLabel={t('closeDialog')} />
}
