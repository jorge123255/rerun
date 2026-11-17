'use client'

import { coworkerLine, type CoworkerLineKey } from '@rerun/contracts'
import { shortRelativeTime } from '@rerun/i18n/format'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { ArrowRight, CopyPlus, Ellipsis, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopCoworkerPreviews } from '@/lib/desktop/coworker-previews'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from '../DesktopApp'
import { useDesktopLocale } from '../DesktopLocale'

// What the tile's menu offers. Each is left out where the board cannot do it.
export type DesktopCoworkerTileActions = {
    onOpenCard?: () => void
    // Both need the grid: a copy is placed on it, a move lands in the first free cell of the Box.
    onDuplicate?: () => void
    onMoveToBox?: (spaceId: string) => void
    // The Boxes it can move to: every Box but its own.
    otherBoxes?: readonly { id: string; name: string | null }[]
}

type DotStatus = 'working' | 'waiting' | 'paused'

const DOT: Record<DotStatus, { className: string; label: 'line.working' | 'line.waiting' | 'line.paused' }> = {
    working: { className: 'bg-emerald-500', label: 'line.working' },
    waiting: { className: 'bg-orange-400', label: 'line.waiting' },
    paused: { className: 'bg-muted-foreground/40', label: 'line.paused' },
}

// Where the coworker stands on this Mac. A read that failed never reads as an error of the
// coworker's, nor as work in progress: it shows no dot. The engine here reports no "asleep" or
// "error" state for a coworker, so upstream's red and its second grey have nothing to show.
export function desktopTileDot(status: BoardActivityStatus | undefined, paused: boolean): DotStatus | null {
    if (paused) return 'paused'
    return status === 'working' ? 'working' : status === 'waiting_human' ? 'waiting' : null
}

/**
 * One coworker in the Simple view's list. It keeps its look and its line at rest whatever it is
 * doing: a dot alone tells where it stands (upstream #278).
 */
export function DesktopCoworkerTile({ agent, status, latest, selected, unseen, disabled = false, onOpen, actions }: {
    agent: DesktopAgentView
    status: BoardActivityStatus | undefined
    latest: DesktopCoworkerPreviews['previews'][string] | null
    selected: boolean
    // A finished run nobody has opened yet.
    unseen: boolean
    disabled?: boolean
    onOpen: () => void
    actions?: DesktopCoworkerTileActions
}) {
    const { t, language } = useDesktopLocale()
    const paused = agent.enabled === false
    // The line reads as it does at rest whatever the coworker is doing: the dot alone tells it.
    const line = coworkerLine({ status: 'idle', paused: false, description: agent.description || null, latest },
        (key: CoworkerLineKey, values) => t(`workspaceView.${key}`, values))
    const menu = !!actions?.onOpenCard
    return <div className={cn('group relative flex items-center rounded-lg transition-colors', selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}>
        <button type="button" disabled={disabled} data-simple-tile-id={agent.id} onClick={onOpen} aria-current={selected ? 'true' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 pl-2 text-left">
            <AgentBuddy agentId={agent.id} mood={paused ? 'asleep' : 'idle'} size={32} facing="right" className="shrink-0" />
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
                    {latest && <span className={cn('shrink-0 text-[11px] text-muted-foreground tabular-nums', menu && 'group-focus-within:invisible group-hover:invisible')}>{shortRelativeTime(latest.updatedAt, language.locale)}</span>}
                </span>
                <span className="flex items-center gap-2">
                    <span data-tile-line className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{line.text || ' '}</span>
                    <StatusDot status={desktopTileDot(status, paused)} unseen={unseen} />
                </span>
            </span>
        </button>
        {/* Where the time sits, on hover or focus. */}
        {actions?.onOpenCard && <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('workspaceView.tile.more', { name: agent.name })}
                    className="absolute top-1.5 right-1.5 size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                    <Ellipsis className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right" className="w-auto">
                <DropdownMenuItem onSelect={actions.onOpenCard} className="gap-2 whitespace-nowrap"><PanelRight className="size-4" />{t('workspaceView.tile.card')}</DropdownMenuItem>
                {(actions.onDuplicate || actions.onMoveToBox) && <DropdownMenuSeparator />}
                {actions.onDuplicate && <DropdownMenuItem onSelect={actions.onDuplicate} className="gap-2 whitespace-nowrap"><CopyPlus className="size-4" />{t('coworker.duplicate')}</DropdownMenuItem>}
                {actions.onMoveToBox && actions.otherBoxes && <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2 whitespace-nowrap"><ArrowRight className="size-4" />{t('coworker.moveBox')}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        {actions.otherBoxes.length === 0 ? <DropdownMenuItem disabled>{t('coworker.noOtherBox')}</DropdownMenuItem>
                            : actions.otherBoxes.map(box => <DropdownMenuItem key={box.id} className="max-w-56 truncate" onSelect={() => actions.onMoveToBox?.(box.id)}>{box.name}</DropdownMenuItem>)}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>}
            </DropdownMenuContent>
        </DropdownMenu>}
    </div>
}

// Where the coworker stands, in a dot: at rest it shows only a run nobody has opened yet.
function StatusDot({ status, unseen }: { status: DotStatus | null; unseen: boolean }) {
    const { t } = useDesktopLocale()
    const dot = status ? DOT[status] : null
    if (!dot) return unseen ? <span data-tile-dot="unseen" className="size-2 shrink-0 rounded-full bg-brand" /> : null
    const label = t(`workspaceView.${dot.label}`)
    return <TooltipLabeled label={label}>
        <span role="img" aria-label={label} data-tile-dot={status} className="relative flex size-2 shrink-0">
            {status === 'working' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70 motion-reduce:animate-none" />}
            <span className={cn('relative size-2 rounded-full', dot.className)} />
        </span>
    </TooltipLabeled>
}
