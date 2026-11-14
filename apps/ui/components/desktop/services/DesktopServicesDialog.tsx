'use client'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { LayoutGridIcon } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from '../DesktopApp'
import { DesktopCoworkerServices } from './DesktopCoworkerServices'

export function DesktopServicesDialog({ agent, dialogControl, focusSlug, focusRequestKey, hideTrigger = false }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl; focusSlug?: string; focusRequestKey?: string; hideTrigger?: boolean }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Apps</Button></DialogTrigger>}
        {open && <DialogContent className="flex h-[80dvh] flex-col sm:max-w-3xl">
            <DialogHeaderBar icon={LayoutGridIcon} title="Apps" description={<>Connections for {agent.name}. Enable Apps in Tools to let this coworker use installed connections.</>} />
            <DesktopCoworkerServices key={agent.id} agentId={agent.id} focusSlug={focusSlug} focusRequestKey={focusRequestKey} />
        </DialogContent>}
    </Dialog>
}
