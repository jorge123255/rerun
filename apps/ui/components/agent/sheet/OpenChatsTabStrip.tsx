'use client'

import { useScrollFade } from '@rerun/ui/primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { SessionTab } from '@/lib/chat/session-tabs'
import { isGeneralTab } from '@/lib/desktop/general-threads'
import { MessagesSquare, PlusIcon, XIcon } from '@/lib/icons'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'

export type TabState = 'live' | 'needs' | 'quiet'

export type OpenChatsTabsProps = {
    tabs: SessionTab[]
    activeIndex: number
    onSelect: (index: number) => void
    onClose: (index: number) => void
    onCreate: () => void
}

// Both the hosted board and the Mac use this strip. Each supplies the status from its own runs.
export function OpenChatsTabStrip({ tabs, activeIndex, onSelect, onClose, onCreate, stateOf, onRename, renameLabel, renderRename, newLabel = 'New conversation', closeLabel = title => `Close ${title}` }:
    OpenChatsTabsProps & { stateOf: (tab: SessionTab) => TabState; newLabel?: string; closeLabel?: (title: string) => string
        onRename?: (id: string) => void; renameLabel?: string; renderRename?: (tab: SessionTab) => ReactNode }) {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
    const fadeMask = useScrollFade(scroller, { axis: 'x' })

    useEffect(() => {
        scroller?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }, [scroller, activeIndex])

    const pinned = tabs.findIndex(tab => isGeneralTab(tab))
    const threads = pinned < 0 ? tabs.map((tab, index) => ({ tab, index })) : tabs.flatMap((tab, index) => index === pinned ? [] : [{ tab, index }])
    const general = pinned < 0 ? null : tabs[pinned]
    return (
        <div role="group" aria-label="Open conversations" className="flex w-full items-center gap-1 px-3">
            {general && (
                <>
                    <button
                        type="button"
                        data-testid="desktop-general-tab"
                        data-general-tab=""
                        data-active={pinned === activeIndex}
                        aria-pressed={pinned === activeIndex}
                        onClick={() => onSelect(pinned)}
                        className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors', pinned === activeIndex ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')}
                    >
                        <MessagesSquare className="size-3.5" />
                        {general.title}
                    </button>
                    <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                </>
            )}
            <div ref={setScroller} className="min-w-0 overflow-x-auto [scrollbar-width:none]" style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}>
                <div className="flex w-max items-center gap-1">
                    {threads.map(({ tab, index }) => {
                        const active = index === activeIndex
                        const field = renderRename?.(tab)
                        if (field) return <div key={tab.uid} data-active={active}>{field}</div>
                        const startRename = tab.id && onRename ? () => onRename(tab.id!) : undefined
                        const button = (
                            <button type="button" aria-pressed={active} title={tab.title} onClick={() => onSelect(index)}
                                onDoubleClick={startRename} className="flex min-w-0 items-center gap-1.5">
                                <StateDot state={stateOf(tab)} />
                                <span className="max-w-[160px] truncate">{tab.title}</span>
                            </button>
                        )
                        return (
                            <div
                                key={tab.uid}
                                data-active={active}
                                className={cn(
                                    'group flex h-7 shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1 text-xs transition-colors',
                                    active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                                )}
                            >
                                {startRename ? <ContextMenu>
                                    <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
                                    <ContextMenuContent><ContextMenuItem onSelect={startRename}>{renameLabel}</ContextMenuItem></ContextMenuContent>
                                </ContextMenu> : button}
                                <button
                                    type="button"
                                    aria-label={closeLabel(tab.title)}
                                    onClick={() => onClose(index)}
                                    className={cn('flex size-5 shrink-0 items-center justify-center rounded hover:bg-background/60', !active && 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100')}
                                >
                                    <XIcon className="size-3" />
                                </button>
                            </div>
                        )
                    })}
                </div>
            </div>
            <button
                type="button"
                aria-label={newLabel} title={newLabel}
                onClick={onCreate}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
                <PlusIcon className="size-3.5" />
            </button>
        </div>
    )
}

export function StateDot({ state }: { state: TabState }) {
    if (state === 'quiet') return null
    return (
        <span className="relative flex size-1.5 shrink-0">
            {state === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />}
            <span className={cn('relative size-1.5 rounded-full', state === 'live' ? 'bg-emerald-400' : 'bg-amber-400')} />
        </span>
    )
}
