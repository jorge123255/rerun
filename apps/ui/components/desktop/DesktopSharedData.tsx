'use client'

import { DataBrowser } from '@/components/data/DataBrowser'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { DataFocus } from '@/lib/data/source'
import { desktopDataSource } from '@/lib/desktop/data-source'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { useMemo, useState } from 'react'

/**
 * Port of SharedDataPanel: the workspace database every coworker reads and writes, through the
 * authenticated desktop adapter. It is a different file, a different permission and a different
 * URL prefix from any coworker's private database.
 */
function SharedDataPanel() {
    const [expanded, setExpanded] = useState<DataFocus | null>(null)
    const source = useMemo(() => desktopDataSource({ kind: 'shared' }), [])
    return <>
        <DataBrowser source={source} onExpand={setExpanded} />
        {/* Unlike the web panel, the Mac entry is a dialog. Board and gallery views need the row
            width a dialog does not have, so they open at full size in a second browser. */}
        <Dialog open={expanded !== null} onOpenChange={open => !open && setExpanded(null)}>
            <PanelDialogContent className="sm:h-[92dvh] sm:max-w-[min(100rem,95vw)]">
                <DialogHeader className="border-b px-4 py-3">
                    <DialogTitle>Shared database</DialogTitle>
                    <DialogDescription className="sr-only">The workspace shared database, at full size.</DialogDescription>
                </DialogHeader>
                {expanded && <DataBrowser source={source} initial={expanded} />}
            </PanelDialogContent>
        </Dialog>
    </>
}

export function DesktopSharedData({ dialogControl, hideTrigger = false, onCloseAutoFocus }: { dialogControl?: DesktopDialogControl; hideTrigger?: boolean; onCloseAutoFocus?: (event: Event) => void }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Shared database</Button></DialogTrigger>}
        {open && <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="flex h-[80dvh] flex-col sm:max-w-5xl">
            <DialogHeader>
                <DialogTitle>Shared database</DialogTitle>
                <DialogDescription>The workspace database. Coworkers with shared database permission read and write these tables. Browse, filter, edit a row, or save a view.</DialogDescription>
            </DialogHeader>
            <SharedDataPanel />
        </DialogContent>}
    </Dialog>
}
