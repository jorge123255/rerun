'use client'

import { useDesktopLocale } from '../DesktopLocale'

import { ForemanTabsBar, type ForemanTab } from '@rerun/ui/foreman'

export function DesktopForemanTabs({ tab, onTabChange }: { tab: ForemanTab; onTabChange: (tab: ForemanTab) => void }) {
    const { t } = useDesktopLocale()
    return <ForemanTabsBar tab={tab} onTabChange={onTabChange} labels={{ assistant: t('foreman.tabs.assistant'), routines: t('foreman.tabs.routines') }} />
}
