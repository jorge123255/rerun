'use client'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EllipsisIcon } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'

/** A routine's menu, the same in the Chief of Staff's list and in a coworker's (upstream #318's RoutineMenu). Open result is the Mac's own. */
export function DesktopRoutineMenu({ routine, canRename, onRename, onEdit, onRunNow, onOpenResult }: {
    routine: { name: string; enabled: boolean; setupPending?: boolean; lastResult?: { chat?: unknown } | null }
    canRename: boolean
    onRename: () => void
    onEdit: () => void
    onRunNow: () => void
    onOpenResult: () => void
}) {
    const { t } = useDesktopLocale()
    return <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t('routines.options', { name: routine.name })} className="text-muted-foreground"><EllipsisIcon /></Button>
        </DropdownMenuTrigger>
        {/* The rename field takes the focus a beat later; the menu handing it back would steal it. */}
        <DropdownMenuContent align="end" onCloseAutoFocus={event => event.preventDefault()}>
            {canRename && <DropdownMenuItem onSelect={onRename}>{t('routines.rename')}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={onEdit}>{t('routines.edit')}</DropdownMenuItem>
            <DropdownMenuItem disabled={!routine.lastResult?.chat} onSelect={onOpenResult}>{t('routines.openResult')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!!routine.setupPending && !routine.enabled} onSelect={onRunNow}>{t('routines.runNow')}</DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
}
