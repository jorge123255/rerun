'use client'

import { DesktopViewer } from '@/components/desktop/DesktopViewer'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { ChevronRightIcon, MonitorIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useEffect, useState, type ReactNode } from 'react'

export type DesktopOverviewComputer =
    | { status: 'closed' }
    | { status: 'unavailable'; reason: string }
    | { status: 'loading' }
    | { status: 'live'; socketUrl: string }

export function DesktopCoworkerOverviewComputer({ computer, working, disabledReason, loadingSlot, selected, onFocus, onOpen }: {
    computer: DesktopOverviewComputer
    working: boolean
    disabledReason: string | null
    loadingSlot?: ReactNode
    selected: boolean
    onFocus: () => void
    onOpen?: () => void
}) {
    const [gone, setGone] = useState(false)
    const screenKey = computer.status === 'live' ? computer.socketUrl : computer.status === 'unavailable' ? computer.reason : computer.status
    useEffect(() => { setGone(false) }, [screenKey])
    const pictureReason = disabledReason ?? (gone ? 'The screen went away' : computer.status === 'unavailable' ? computer.reason : computer.status === 'closed' ? 'Its computer is not open in this window.' : computer.status === 'live' && !computer.socketUrl ? 'This coworker’s computer status is unavailable.' : null)
    const live = computer.status === 'live' && !!computer.socketUrl && !pictureReason
    const clickReason = pictureReason ?? (live && !onOpen ? 'Opening this computer is not available in this window.' : null)
    return (
        <div data-overview-focus="computer" tabIndex={selected ? 0 : -1} onFocus={onFocus} className="min-w-0 outline-none">
        <TooltipDisabledReason reason={clickReason ?? undefined} className="flex w-full">
            <button type="button" tabIndex={-1} disabled={!!clickReason} onClick={onOpen} className="group w-full space-y-1.5 text-left disabled:cursor-not-allowed">
                <span className="flex items-center justify-between px-1">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <span className={cn('size-1.5 rounded-full', live && working ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
                        {live ? (working ? 'Working on its computer' : 'Its computer') : 'Computer'}
                    </span>
                    {live && onOpen && <ChevronRightIcon className="size-3.5 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />}
                </span>
                <span className="relative flex aspect-[16/7] overflow-hidden rounded-lg border border-border bg-muted/40">
                    {computer.status === 'loading' && !pictureReason && (loadingSlot ?? <span className="flex flex-1 items-center justify-center text-xs text-muted-foreground">Loading this computer…</span>)}
                    {live && <DesktopViewer viewOnly socketUrl={computer.socketUrl} onDisconnect={() => setGone(true)} />}
                    {!!pictureReason && (
                        <span className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center text-muted-foreground">
                            <MonitorIcon className="size-5" />
                            <span className="text-xs">{pictureReason}</span>
                        </span>
                    )}
                </span>
            </button>
        </TooltipDisabledReason>
        </div>
    )
}
