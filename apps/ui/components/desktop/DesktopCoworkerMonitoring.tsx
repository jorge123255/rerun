'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { useDesktopLocale } from './DesktopLocale'
import { DesktopCoworkerMonitoringBody } from './DesktopCoworkerMonitoringBody'

export function DesktopCoworkerMonitoring({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">{t('monitoring.title')}</Button></DialogTrigger>
        <DialogContent closeLabel={t('monitoring.close')} className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
            <DialogHeader className="shrink-0">
                <DialogTitle>{t('monitoring.title')}</DialogTitle>
                <DialogDescription>{t('monitoring.description', { name: agent.name })}</DialogDescription>
            </DialogHeader>
            {open && <DesktopCoworkerMonitoringBody key={agent.id} agent={agent} />}
        </DialogContent>
    </Dialog>
}
