'use client'

import { useEffect, useRef, useState } from 'react'
import { SETUP_TAB } from '@/components/agent/agent-tabs'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopAgentPanelSetup } from './setup/DesktopAgentPanelSetup'

export function DesktopCoworkerSetup(props: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    return <CoworkerSetupDialog key={props.agent.id} {...props} />
}

function CoworkerSetupDialog({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const [dirty, setDirty] = useState(false)
    const [saving, setSaving] = useState(false)
    const [confirmDiscard, setConfirmDiscard] = useState(false)
    const active = useRef(true)
    const latest = useRef({ open, setOpen, saving })
    latest.current = { open, setOpen, saving }
    useEffect(() => { active.current = true; return () => { active.current = false } }, [])
    useEffect(() => {
        if (!open) { setDirty(false); setSaving(false); setConfirmDiscard(false) }
    }, [open])

    // The editor already confirms its Cancel button. X, Escape and outside clicks must use
    // the same discard decision, and cannot dismiss a save whose acknowledgment is pending.
    const close = () => {
        if (!active.current || !latest.current.open || latest.current.saving) return
        setConfirmDiscard(false)
        setDirty(false)
        latest.current.setOpen(false)
    }
    const changeOpen = (next: boolean) => {
        if (saving) return
        if (!next && dirty) { setConfirmDiscard(true); return }
        setOpen(next)
    }

    return <Dialog open={open} onOpenChange={changeOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">{SETUP_TAB.label}</Button></DialogTrigger>
        {open && <DialogContent className="flex h-[80dvh] flex-col sm:max-w-2xl" showCloseButton={!saving}>
            <DialogHeader>
                <DialogTitle>{SETUP_TAB.label}</DialogTitle>
                <DialogDescription>{SETUP_TAB.description}.</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1">
                <DesktopAgentPanelSetup agentId={agent.id} onDirtyChange={setDirty} onSavingChange={setSaving} onCancel={close} />
            </div>
        </DialogContent>}
        {open && confirmDiscard && <ConfirmDialog open onOpenChange={setConfirmDiscard} pending={saving}
            title="Discard unsaved setup changes?"
            description="Your changes to the required answer and install instructions will be lost."
            confirmLabel="Discard changes" cancelLabel="Keep editing" onConfirm={close} />}
    </Dialog>
}
