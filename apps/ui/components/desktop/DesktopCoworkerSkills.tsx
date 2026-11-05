'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopAgentPanelSkills } from './skills/DesktopAgentPanelSkills'

// The Mac entry to the Skills panel, shaped like the other coworker dialogs (Files, Knowledge,
// Capabilities): one outline button on the coworker card that opens the panel.
export function DesktopCoworkerSkills({ agent, dialogControl, focusSlug }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl; focusSlug?: string | null }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return (
        <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
            <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Skills</Button></DialogTrigger>
            {open && <DialogContent className="flex h-[75dvh] flex-col sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Skills</DialogTitle>
                    <DialogDescription>{agent.name}’s reusable procedures, plus the changes it proposed for your review.</DialogDescription>
                </DialogHeader>
                <DesktopAgentPanelSkills key={`${agent.id}:${focusSlug ?? ''}`} agentId={agent.id} focusSlug={focusSlug} />
                <DialogFooter><DialogClose asChild><Button type="button">Done</Button></DialogClose></DialogFooter>
            </DialogContent>}
        </Dialog>
    )
}
