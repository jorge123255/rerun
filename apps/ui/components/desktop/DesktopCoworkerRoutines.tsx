'use client'

import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopCoworkerSchedules } from './schedules/DesktopCoworkerSchedules'

export function DesktopCoworkerRoutines({ agent, dialogControl, onOpenChat }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl; onOpenChat: (id: string, title?: string) => void }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const scope = `${agent.id}:${open}`
    const latest = useRef({ scope, setOpen, onOpenChat })
    const cycle = useRef({ scope })
    if (cycle.current.scope !== scope) cycle.current = { scope }
    const captured = cycle.current
    latest.current = { scope, setOpen, onOpenChat }
    useEffect(() => { cycle.current = captured; return () => { if (cycle.current === captured) cycle.current = { scope: '' } } }, [captured])
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Routines</Button></DialogTrigger>
        {open && <DialogContent className="flex h-[80dvh] flex-col sm:max-w-3xl">
            <DialogHeader><DialogTitle>Routines</DialogTitle><DialogDescription>{agent.name}’s recurring and scheduled tasks. Rerun must remain open for a routine to run.</DialogDescription></DialogHeader>
            <DesktopCoworkerSchedules key={agent.id} agentId={agent.id} onOpenSession={chat => {
                if (cycle.current !== captured || !open || chat.agentId !== agent.id || !chat.sessionId) return
                cycle.current = { scope: '' }
                latest.current.setOpen(false)
                latest.current.onOpenChat(chat.sessionId, chat.title)
            }} />
        </DialogContent>}
    </Dialog>
}
