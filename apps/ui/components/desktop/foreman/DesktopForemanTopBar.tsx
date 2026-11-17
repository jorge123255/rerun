'use client'

import type { OrbActivity } from '@rerun/ui/foreman'
import type { ReactNode } from 'react'
import { OpenChatsTabStrip, type TabState } from '@/components/agent/sheet/OpenChatsTabStrip'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopForemanOrb } from '../panel-motion/DesktopForemanOrb'

export type DesktopForemanFramedBar = {
    /** The button to every conversation and the list it opens, at the left where a coworker keeps its own. */
    history?: ReactNode
    /** What the Mac keeps at the end of the header: an error, its own permissions. */
    end?: ReactNode
    /** The thread on screen, null on General. */
    thread: { id: string; title: string; state: TabState; /** It has a title of its own, not the placeholder of a task nobody named yet. */ named: boolean } | null
    onShowGeneral: () => void
    onNewTask?: () => void
}

/**
 * The Chief of Staff's header in the Simple view's middle, the one a coworker's chat has on the Mac
 * (upstream #316): its conversations at the left, its name in the middle, then General and the
 * thread on screen as tabs with + for a new task. The board's floating or docked Chief of Staff
 * keeps its own header.
 */
export function DesktopForemanTopBar({ bar, name }: {
    bar: DesktopForemanFramedBar
    /** The name in the middle. A button there opens the panel beside the chat; without one it only reads. */
    name: ReactNode
}) {
    const { t } = useDesktopLocale()
    const tabs = [{ uid: 'general:foreman', id: null, title: t('foreman.mainConversation'), kind: 'general' as const },
        ...(bar.thread ? [{ uid: bar.thread.id, id: bar.thread.id, title: bar.thread.title }] : [])]
    return <div data-foreman-top-bar className="relative z-40 shrink-0">
        <header className="grid grid-cols-[minmax(2.5rem,1fr)_minmax(0,max-content)_minmax(2.5rem,1fr)] items-center gap-1 px-3 pt-3">
            <div className="flex min-w-0 items-center justify-start">{bar.history}</div>
            <h1 aria-label={t('workspaceView.foreman.name')} className="min-w-0">{name}</h1>
            <div className="flex min-w-0 items-center justify-end gap-1">{bar.end}</div>
        </header>
        <div className="pt-2 pb-1">
            <OpenChatsTabStrip tabs={tabs} activeIndex={bar.thread ? 1 : 0} newLabel={t('foreman.newTask')} closeLabel={title => t('closeTab', { title })}
                stateOf={tab => tab.id && tab.id === bar.thread?.id ? bar.thread.state : 'quiet'}
                onSelect={index => { if (index === 0) bar.onShowGeneral() }} onClose={bar.onShowGeneral} onCreate={() => bar.onNewTask?.()} />
        </div>
    </div>
}

/** Who the middle belongs to: the orb and the name, as a coworker's pill shows its buddy and its name. */
export function DesktopForemanNameMark({ orbState }: { orbState: OrbActivity }) {
    const { t } = useDesktopLocale()
    return <>
        <span className="flex size-7 shrink-0 items-center justify-center"><DesktopForemanOrb role="header" size={24} fallback={orbState} facing="right" /></span>
        <span className="truncate font-medium">{t('workspaceView.foreman.name')}</span>
    </>
}
