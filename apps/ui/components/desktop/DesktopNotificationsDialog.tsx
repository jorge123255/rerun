'use client'

import { DIALOG_TABS_CONTENT, DIALOG_TABS_HEADER, DialogTabs } from '@/components/dialogs/DialogTabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDesktopLocale } from './DesktopLocale'
import { DesktopNotificationSettings } from './DesktopNotificationSettings'

// Original NotificationsDialog composition; account email has no local Mac channel.
export function DesktopNotificationsDialog({ open, onOpenChange, pinnedCoworkerId, onCloseAutoFocus }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    pinnedCoworkerId?: string | null
    onCloseAutoFocus?: (event: Event) => void
}) {
    const { t } = useDesktopLocale()
    const tabs = [{ value: 'coworkers', label: t('notificationUI.coworkers') }] as const
    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent closeLabel={t('closeDialog')} className={DIALOG_TABS_CONTENT} onCloseAutoFocus={onCloseAutoFocus}>
            <DialogTabs tabs={tabs} tab="coworkers" onTabChange={() => {}} header={
                <DialogHeader className={DIALOG_TABS_HEADER}>
                    <DialogTitle>{t('notifications')}</DialogTitle>
                    <DialogDescription>{t('notificationUI.description')}</DialogDescription>
                </DialogHeader>
            }>
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 max-sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6">
                    {open && <DesktopNotificationSettings key={pinnedCoworkerId ?? 'workspace'} pinnedCoworkerId={pinnedCoworkerId} />}
                </div>
            </DialogTabs>
        </DialogContent>
    </Dialog>
}
