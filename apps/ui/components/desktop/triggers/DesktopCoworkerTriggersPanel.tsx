'use client'

import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { WebhookIcon } from '@/lib/icons'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import { DesktopCoworkerTriggers } from './DesktopCoworkerTriggers'
import {
    unavailableTriggerRunModelCatalog,
    desktopTriggerPromptLock,
    type DesktopTriggerRunModelCatalog,
    type DesktopTriggerTemplateLockState,
} from '@/lib/desktop/triggers'

/** B5 wrapper matching DesktopCoworkerRoutines — root mounts beside Routines / Control Center Open → Triggers. */
export function DesktopCoworkerTriggersPanel({
    agent,
    dialogControl,
    onOpenChat,
    ingressAvailable = false,
    modelCatalog = unavailableTriggerRunModelCatalog(),
    templateLock = desktopTriggerPromptLock(false),
}: {
    agent: { id: string; name: string }
    dialogControl?: DesktopDialogControl
    onOpenChat: (id: string, title?: string) => void
    ingressAvailable?: boolean
    modelCatalog?: DesktopTriggerRunModelCatalog
    templateLock?: DesktopTriggerTemplateLockState
}) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const editing = useRef({ dirty: false, busy: false })
    const scope = `${agent.id}:${open}`
    const latest = useRef({ scope, setOpen, onOpenChat })
    const cycle = useRef({ scope })
    if (cycle.current.scope !== scope) cycle.current = { scope }
    const captured = cycle.current
    latest.current = { scope, setOpen, onOpenChat }
    useEffect(() => {
        cycle.current = captured
        return () => { if (cycle.current === captured) cycle.current = { scope: '' } }
    }, [captured])

    return (
        <Dialog open={open} onOpenChange={next => { if (!next && (editing.current.busy || (editing.current.dirty && !window.confirm('Discard unsaved trigger changes?')))) return; setOpen(next) }} asSheet={false}>
            <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Triggers</Button></DialogTrigger>
            {open && (
                <DialogContent className="flex h-[80dvh] max-h-[700px] w-full flex-col sm:max-w-3xl">
                    <DialogHeaderBar icon={WebhookIcon} title="Triggers" description={<>{agent.name}&apos;s webhook URLs. These URLs work only on this Mac. Copying or previewing a URL never starts a run.</>} />
                    <DesktopCoworkerTriggers
                        key={agent.id}
                        agentId={agent.id}
                        onEditStateChange={state => { editing.current = state }}
                        ingressAvailable={ingressAvailable}
                        modelCatalog={modelCatalog}
                        templateLock={templateLock}
                        onOpenSession={chat => {
                            if (cycle.current !== captured || !open || !chat.sessionId) return
                            cycle.current = { scope: '' }
                            latest.current.setOpen(false)
                            latest.current.onOpenChat(chat.sessionId, chat.title)
                        }}
                    />
                </DialogContent>
            )}
        </Dialog>
    )
}
