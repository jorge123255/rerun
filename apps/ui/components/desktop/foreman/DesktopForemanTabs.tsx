'use client'

import { ForemanTabsBar, type ForemanTab } from '@rerun/ui/foreman'

export function DesktopForemanTabs({ tab, onTabChange }: { tab: ForemanTab; onTabChange: (tab: ForemanTab) => void }) {
    return <ForemanTabsBar tab={tab} onTabChange={onTabChange} />
}
