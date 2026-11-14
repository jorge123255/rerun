'use client'

import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { CalendarIcon } from '@/lib/icons'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopCoworkerSchedules } from './schedules/DesktopCoworkerSchedules'
import { useDesktopLocale } from './DesktopLocale'

export function DesktopCoworkerRoutines({ agent, dialogControl, onOpenChat }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl; onOpenChat: (id: string, title?: string) => void }) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const scope = `${agent.id}:${open}`
    const latest = useRef({ scope, setOpen, onOpenChat })
    const cycle = useRef({ scope })
    if (cycle.current.scope !== scope) cycle.current = { scope }
    const captured = cycle.current
    latest.current = { scope, setOpen, onOpenChat }
    useEffect(() => { cycle.current = captured; return () => { if (cycle.current === captured) cycle.current = { scope: '' } } }, [captured])
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">{t('coworker.destinations.scheduled')}</Button></DialogTrigger>
        {open && <DialogContent className="flex h-[80dvh] flex-col sm:max-w-3xl">
            <DialogHeaderBar icon={CalendarIcon} title={t('coworker.destinations.scheduled')} description={t('routines.coworker.dialogDescription', { name: agent.name })} />
            <DesktopCoworkerSchedules key={agent.id} agentId={agent.id} onOpenSession={chat => {
                if (cycle.current !== captured || !open || chat.agentId !== agent.id || !chat.sessionId) return
                cycle.current = { scope: '' }
                latest.current.setOpen(false)
                latest.current.onOpenChat(chat.sessionId, chat.title)
            }} />
        </DialogContent>}
    </Dialog>
}
