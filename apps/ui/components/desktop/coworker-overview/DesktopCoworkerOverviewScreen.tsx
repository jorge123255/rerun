'use client'

import { useDesktopLocale } from '../DesktopLocale'
import { AGENT_TABS } from '@/components/agent/agent-tabs'
import { SidePanelTabSwitcher } from '@/components/layout/SidePanelTabSwitcher'
import { Button } from '@/components/ui/button'
import { desktopOverviewSiblingTabs, desktopOverviewViewOf, DESKTOP_OVERVIEW_PUBLISHED_UNAVAILABLE, type DesktopOverviewTab, type DesktopOverviewVisibility } from '@/lib/desktop/coworker-overview'
import { ChevronLeftIcon, GlobeIcon, XIcon } from '@/lib/icons'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

const TAB_ICONS = Object.fromEntries(AGENT_TABS.map(tab => [tab.id, tab.icon]))

export function DesktopCoworkerOverviewScreen({ agentId, name, mood, tab, visibility, servicesNeedConfig, onTab, onBack, onClose, children }: {
    agentId: string
    name: string
    mood: 'asleep' | 'working' | 'idle'
    tab: DesktopOverviewTab
    visibility: DesktopOverviewVisibility
    servicesNeedConfig: boolean
    onTab: (tab: DesktopOverviewTab) => void
    onBack: () => void
    onClose: () => void
    children?: ReactNode
}) {
    const { t } = useDesktopLocale()
    const view = desktopOverviewViewOf(tab)
    const tabs = desktopOverviewSiblingTabs(tab, visibility)
    const label = t(`coworker.views.${view}`)
    const screen = useRef<HTMLDivElement>(null)
    const back = useRef<HTMLButtonElement>(null)
    useLayoutEffect(() => {
        const entry = screen.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? back.current
        entry?.focus({ preventScroll: true })
    }, [])
    return (
        <div ref={screen} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
                <Button ref={back} variant="ghost" size="sm" onClick={onBack} className="min-w-0 shrink pl-1.5">
                    <ChevronLeftIcon className="size-4" />
                    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-muted">
                        <AgentBuddy agentId={agentId} mood={mood} size={16} facing="right" />
                    </span>
                    <span className="truncate text-muted-foreground">{name}</span>
                </Button>
                <span className="text-muted-foreground/50">/</span>
                <span className="shrink-0 px-1.5 text-sm font-semibold">{label}</span>
                <Button aria-label={t('closePanel')} variant="ghost" size="icon-sm" onClick={onClose} className="ml-auto"><XIcon className="size-4" /></Button>
            </div>
            <SidePanelTabSwitcher
                tabs={tabs.map(id => ({ id, icon: TAB_ICONS[id] ?? GlobeIcon, label: t(`coworker.tabs.${id}`), dot: id === 'services' && servicesNeedConfig }))}
                value={tab} label={label} onChange={onTab}
            >
                <div className="relative min-h-0 flex-1 overflow-hidden">
                    <div className="absolute inset-0 flex flex-col overflow-y-auto">
                        {children ?? (tab === 'published' ? <p className="p-6 text-center text-sm text-muted-foreground">{DESKTOP_OVERVIEW_PUBLISHED_UNAVAILABLE}</p> : <p className="p-6 text-center text-sm text-muted-foreground">This section is not mounted in this window.</p>)}
                    </div>
                </div>
            </SidePanelTabSwitcher>
        </div>
    )
}
