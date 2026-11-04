'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { DesktopCoworkerMonitoringBody } from './DesktopCoworkerMonitoringBody'

export function DesktopCoworkerMonitoring({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Monitoring</Button></DialogTrigger>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
            <DialogHeader className="shrink-0">
                <DialogTitle>Monitoring</DialogTitle>
                <DialogDescription>Runs for {agent.name} over the selected period. Updates while this view is open.</DialogDescription>
            </DialogHeader>
            {open && <DesktopCoworkerMonitoringBody key={agent.id} agent={agent} />}
        </DialogContent>
    </Dialog>
}
