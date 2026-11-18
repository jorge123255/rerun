'use client'

import { WELCOME_ORB_SIZE, type OrbActivity } from '@rerun/ui/foreman'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { XIcon } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopForemanOrb } from '../panel-motion/DesktopForemanOrb'
import { DesktopWorkRegister } from './work/DesktopWorkRegister'

/**
 * The Chief of Staff's column beside its chat in the Simple view, the place a coworker's card has
 * (upstream #317): who it is, the team's work register, then every routine of the workspace.
 */
export function DesktopForemanDetails({ orbState, shown, onClose, routines }: {
    orbState: OrbActivity
    // False while the column is mounted out of sight: nothing in it moves.
    shown: boolean
    onClose: () => void
    // The workspace's routines, the list the Routines tab shows on the board.
    routines: ReactNode
}) {
    const { t } = useDesktopLocale()
    return <div data-foreman-details className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
            <Button aria-label={t('coworker.closeCard')} variant="ghost" size="icon-sm" onClick={onClose}><XIcon className="size-4" /></Button>
        </div>
        <div className="flex shrink-0 flex-col items-center px-4 pt-4 pb-3">
            <DesktopForemanOrb role="header" size={WELCOME_ORB_SIZE} fallback={orbState} paused={!shown} />
            <span className="mt-2 max-w-full truncate text-base leading-tight font-semibold">{t('workspaceView.foreman.name')}</span>
            <span className="text-xs text-muted-foreground">{t('workspaceView.foreman.line')}</span>
        </div>
        {/* The team's shared work register and its "Coordinate the team" routine. */}
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-border"><DesktopWorkRegister active={shown} /></div>
        <h3 className="shrink-0 px-4 pt-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t('coworker.destinations.scheduled')}</h3>
        {routines}
    </div>
}
