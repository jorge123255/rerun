'use client'

import { useScrollFade } from '@rerun/ui/primitives'
import { useEffect, useState } from 'react'
import type { SessionTab } from '@/lib/chat/session-tabs'
import { PlusIcon, XIcon } from '@/lib/icons'
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
export function OpenChatsTabStrip({ tabs, activeIndex, onSelect, onClose, onCreate, stateOf, newLabel = 'New conversation' }:
    OpenChatsTabsProps & { stateOf: (tab: SessionTab) => TabState; newLabel?: string }) {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
    const fadeMask = useScrollFade(scroller, { axis: 'x' })

    useEffect(() => {
        scroller?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }, [scroller, activeIndex])

    return (
        <div role="group" aria-label="Open conversations" className="flex w-full items-center gap-1 px-3">
            <div ref={setScroller} className="min-w-0 overflow-x-auto [scrollbar-width:none]" style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}>
                <div className="flex w-max items-center gap-1">
                    {tabs.map((tab, index) => {
                        const active = index === activeIndex
                        return (
                            <div
                                key={tab.uid}
                                data-active={active}
                                className={cn(
                                    'group flex h-7 shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1 text-xs transition-colors',
                                    active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                                )}
                            >
                                <button type="button" aria-pressed={active} title={tab.title} onClick={() => onSelect(index)} className="flex min-w-0 items-center gap-1.5">
                                    <StateDot state={stateOf(tab)} />
                                    <span className="max-w-[160px] truncate">{tab.title}</span>
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Close ${tab.title}`}
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

function StateDot({ state }: { state: TabState }) {
    if (state === 'quiet') return null
    return (
        <span className="relative flex size-1.5 shrink-0">
            {state === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />}
            <span className={cn('relative size-1.5 rounded-full', state === 'live' ? 'bg-emerald-400' : 'bg-amber-400')} />
        </span>
    )
}
