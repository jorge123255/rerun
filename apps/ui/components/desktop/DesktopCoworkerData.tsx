'use client'

import { DataBrowser } from '@/components/data/DataBrowser'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { DataFocus } from '@/lib/data/source'
import { desktopDataSource } from '@/lib/desktop/data-source'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { useMemo, useState } from 'react'
import type { DesktopAgentView } from './DesktopApp'

/**
 * Port of AgentPanelData: the coworker's private database, through the authenticated desktop
 * adapter. The browser is handed a bound source, so it never learns which database it drew and
 * cannot be pointed at another one.
 */
export function DesktopCoworkerDataBody({ agentId, initial, requireInitialView }: { agentId: string; initial?: DataFocus | null; requireInitialView?: boolean }) {
    const [expanded, setExpanded] = useState<DataFocus | null>(null)
    const source = useMemo(() => desktopDataSource({ kind: 'agent', agentId }), [agentId])
    return <>
        <DataBrowser source={source} initial={initial ?? null} requireInitialView={requireInitialView} onExpand={setExpanded} />
        {/* The dialog is too narrow for a board or a gallery: the same table and view open here
            at full size, as a second browser that reads the same private database. */}
        <Dialog open={expanded !== null} onOpenChange={open => !open && setExpanded(null)}>
            <PanelDialogContent className="sm:h-[92dvh] sm:max-w-[min(100rem,95vw)]">
                <DialogHeader className="border-b px-4 py-3">
                    <DialogTitle>Coworker database</DialogTitle>
                    <DialogDescription className="sr-only">The private database of this coworker, at full size.</DialogDescription>
                </DialogHeader>
                {expanded && <DataBrowser source={source} initial={expanded} />}
            </PanelDialogContent>
        </Dialog>
    </>
}

export function DesktopCoworkerData({ agent, dialogControl, initial, hideTrigger = false, onCloseAutoFocus, requireInitialView }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl; initial?: DataFocus | null; hideTrigger?: boolean; onCloseAutoFocus?: (event: Event) => void; requireInitialView?: boolean }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Database</Button></DialogTrigger>}
        {open && <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="flex h-[80dvh] flex-col sm:max-w-5xl">
            <DialogHeader>
                <DialogTitle>Database</DialogTitle>
                <DialogDescription>{agent.name}’s private database. Browse, filter, edit a row, or save a view. Only {agent.name} reads and writes it.</DialogDescription>
            </DialogHeader>
            <DesktopCoworkerDataBody key={agent.id} agentId={agent.id} initial={initial} requireInitialView={requireInitialView} />
        </DialogContent>}
    </Dialog>
}
