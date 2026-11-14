'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ComponentType, ReactNode } from 'react'

export type SidePanelSwitcherTab<T extends string> = {
    id: T
    icon: ComponentType<{ className?: string }>
    label: string
    dot?: boolean
}

export function SidePanelTabSwitcher<T extends string>({ tabs, value, label, onChange, children }: {
    tabs: SidePanelSwitcherTab<T>[]
    value: T
    label: string
    onChange: (id: T) => void
    children: ReactNode
}) {
    if (tabs.length < 2) return children
    return (
        <Tabs value={value} activationMode="manual" className="min-h-0 flex-1" onValueChange={id => {
            const tab = tabs.find(item => item.id === id)
            if (tab) onChange(tab.id)
        }}>
            <div className="shrink-0 border-b border-border px-3 py-2">
                <TabsList aria-label={label} className="flex h-auto w-full gap-1">
                    {tabs.map(tab => (
                        <TabsTrigger
                            key={tab.id}
                            value={tab.id}
                            className="h-8 min-w-0 flex-1 gap-1.5 rounded-md border px-1 text-[12px] after:hidden hover:border-foreground/20 data-[state=active]:border-primary/40 data-[state=active]:text-primary data-[state=active]:ring-1 data-[state=active]:ring-primary/40"
                        >
                            <tab.icon aria-hidden className="size-3.5 shrink-0" />
                            <span className="truncate">{tab.label}</span>
                            {tab.dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-red-500" />}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </div>
            {tabs.map(tab => (
                <TabsContent key={tab.id} value={tab.id} className="flex min-h-0 flex-1 flex-col">
                    {tab.id === value ? children : null}
                </TabsContent>
            ))}
        </Tabs>
    )
}
