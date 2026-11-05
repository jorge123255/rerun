'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { flushDesktopBrainDrafts } from '@/lib/desktop/use-brain-page-draft'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { DesktopBrainPanel } from './DesktopBrainPanel'
import type { DesktopBrainActions } from './types'

/**
 * The panel in a dialog, with the close path this build already expects: a close flushes the page
 * that is being edited first, and refuses to close when a write could not land, so no keystroke is
 * dropped by a dismissal. Quit is covered by the same drafts through `subscribeDraftShutdown`.
 */
export function DesktopBrainDialog({ actions, dialogControl, hideTrigger = false, renderProposals, triggerLabel = 'Company Brain' }: {
    actions: DesktopBrainActions
    dialogControl?: DesktopDialogControl
    hideTrigger?: boolean
    renderProposals?: () => ReactNode
    triggerLabel?: string
}) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const [closing, setClosing] = useState(false)

    async function requestOpen(next: boolean) {
        if (next) { setOpen(true); return }
        if (closing) return
        setClosing(true)
        try {
            const flushed = await flushDesktopBrainDrafts()
            if (!flushed) {
                toast.error('Some edits could not be saved. The Brain stays open so nothing is lost.')
                return
            }
            setOpen(false)
        } finally {
            setClosing(false)
        }
    }

    return <Dialog open={open} onOpenChange={requestOpen} asSheet={false}>
        {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">{triggerLabel}</Button></DialogTrigger>}
        {open && <DialogContent className="flex h-[85dvh] flex-col gap-0 p-0 sm:max-w-6xl">
            <DialogHeader className="border-b border-border px-4 py-3">
                <DialogTitle>Company Brain</DialogTitle>
                <DialogDescription>What every coworker of this workspace reads about the company. Pages save as you type; version history keeps every change.</DialogDescription>
            </DialogHeader>
            <DesktopBrainPanel actions={actions} onClose={() => { void requestOpen(false) }} renderProposals={renderProposals} />
        </DialogContent>}
    </Dialog>
}
