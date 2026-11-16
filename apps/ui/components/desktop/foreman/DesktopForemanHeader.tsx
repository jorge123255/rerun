'use client'

import { useDesktopLocale } from '../DesktopLocale'

import type { PointerEvent, ReactNode } from 'react'
import { ForemanHeaderBar, HEADER_ORB_SIZE, type ForemanAnchor, type OrbActivity } from '@rerun/ui/foreman'
import { DesktopForemanOrb } from '../panel-motion/DesktopForemanOrb'
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
    crumb,
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
    /** The thread on screen, on its own row under the tabs, as upstream ForemanHeader places ForemanThreadCrumb. */
    crumb?: ReactNode
}) {
    const { t } = useDesktopLocale()
    return (
        <ForemanHeaderBar
            anchor={anchor}
            orbState={orbState}
            orbPaused={!open}
            orb={<DesktopForemanOrb role="header" size={HEADER_ORB_SIZE} fallback={orbState} facing="right" paused={!open} />}
            onClose={onClose}
            closeLabel={t('foreman.closeChat')}
            closeTooltip={t('foreman.close')}
            resizeLabel={t('foreman.resize')}
            closeDisabledReason={closeDisabledReason}
            onGutter
            onDragPointerDown={onDragPointerDown}
            onToggleSheetDetent={onToggleSheetDetent}
            tabs={<><DesktopForemanTabs tab={tab} onTabChange={onTabChange} />{tab === 'assistant' && crumb}</>}
            actions={actions}
        />
    )
}
