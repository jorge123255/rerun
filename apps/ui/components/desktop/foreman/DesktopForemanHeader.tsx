'use client'

import type { PointerEvent, ReactNode } from 'react'
import { ForemanHeaderBar, type ForemanAnchor, type OrbActivity } from '@rerun/ui/foreman'
import { DesktopForemanTabs } from './DesktopForemanTabs'
import type { DesktopForemanUiTab } from '@/lib/desktop/foreman-client'

export function DesktopForemanHeader({
    anchor,
    orbState,
    open,
    tab,
    onTabChange,
    onClose,
    closeDisabledReason,
    onDragPointerDown,
    onToggleSheetDetent,
    actions,
}: {
    anchor: ForemanAnchor
    orbState: OrbActivity
    open: boolean
    tab: DesktopForemanUiTab
    onTabChange: (tab: DesktopForemanUiTab) => void
    onClose: () => void
    closeDisabledReason?: string
    onDragPointerDown?: (event: PointerEvent<HTMLElement>) => void
    onToggleSheetDetent?: () => void
    actions?: ReactNode
}) {
    return (
        <ForemanHeaderBar
            anchor={anchor}
            orbState={orbState}
            orbPaused={!open}
            onClose={onClose}
            closeDisabledReason={closeDisabledReason}
            onGutter
            onDragPointerDown={onDragPointerDown}
            onToggleSheetDetent={onToggleSheetDetent}
            tabs={<DesktopForemanTabs tab={tab} onTabChange={onTabChange} />}
            actions={actions}
        />
    )
}
