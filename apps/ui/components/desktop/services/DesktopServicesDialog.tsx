'use client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from '../DesktopApp'
import { DesktopCoworkerServices } from './DesktopCoworkerServices'

export function DesktopServicesDialog({ agent, dialogControl, focusSlug, focusRequestKey, hideTrigger = false }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl; focusSlug?: string; focusRequestKey?: string; hideTrigger?: boolean }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Apps</Button></DialogTrigger>}
        {open && <DialogContent className="flex h-[80dvh] flex-col sm:max-w-3xl">
            <DialogHeader><DialogTitle>Apps</DialogTitle><DialogDescription>Connections for {agent.name}. Enable Apps in Tools to let this coworker use installed connections.</DialogDescription></DialogHeader>
            <DesktopCoworkerServices key={agent.id} agentId={agent.id} focusSlug={focusSlug} focusRequestKey={focusRequestKey} />
        </DialogContent>}
    </Dialog>
}
