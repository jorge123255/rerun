'use client'

import { Tabs, TabsList, TabsTrigger } from '../primitives'
import { TooltipDisabledReason } from '../Tooltip'

export type ForemanTab = 'assistant' | 'tasks' | 'routines'

export const FOREMAN_TABS: readonly { id: ForemanTab; label: string; disabledReason?: string }[] = [
    { id: 'assistant', label: 'Ask' },
    { id: 'routines', label: 'Routines' },
]

export function ForemanTabsBar({ tab, onTabChange, labels }: { tab: ForemanTab; onTabChange: (tab: ForemanTab) => void; labels?: Partial<Record<ForemanTab, string>> }) {
    return (
        <Tabs value={tab} onValueChange={value => onTabChange(value as ForemanTab)} className="mx-2 border-b border-border">
            <TabsList aria-label="Foreman" className="h-9 gap-0">
                {FOREMAN_TABS.map(({ id, label, disabledReason }) => (
                    <TooltipDisabledReason key={id} reason={disabledReason} side="bottom" className="h-full rounded-md">
                        <TabsTrigger value={id} disabled={Boolean(disabledReason)}>
                            {labels?.[id] ?? label}
                        </TabsTrigger>
                    </TooltipDisabledReason>
                ))}
            </TabsList>
        </Tabs>
    )
}
