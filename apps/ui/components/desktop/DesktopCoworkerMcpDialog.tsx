'use client'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { ServerIcon } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopCoworkerMcp } from './mcp/DesktopCoworkerMcp'

export function DesktopCoworkerMcpDialog({ agent, dialogControl, hideTrigger = false }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl; hideTrigger?: boolean }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">MCP servers</Button></DialogTrigger>}
        {open && <DialogContent className="flex h-[80dvh] flex-col sm:max-w-3xl">
            <DialogHeaderBar icon={ServerIcon} title="MCP servers" description={<>Connections for {agent.name}. HTTPS servers and local programs require separate permissions in Tools.</>} />
            <DesktopCoworkerMcp key={agent.id} agentId={agent.id} />
        </DialogContent>}
    </Dialog>
}
