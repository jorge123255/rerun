'use client'

import { byRecency } from '@rerun/contracts'
import { Orb } from '@rerun/ui/foreman'
import { Plus, Search, Users } from 'lucide-react'
import { useScrollFade } from '@rerun/ui/primitives'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopCoworkerPreviews } from '@/lib/desktop/coworker-previews'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from '../DesktopApp'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopCoworkerTile } from './DesktopCoworkerTile'

/**
 * The left column of the Simple view: the workspace, search, then the Chief of Staff and one tile
 * per coworker, the most recently active first.
 */
export function DesktopSimpleSidebar({ workspaceMenu, agents, statuses, previews, selectedId, foremanOpen, disabled = false, onOpenCoworker, onOpenCard, onOpenForeman, onSearch, onNewCoworker, inboxSlot, unseenIds, boxes, boxOf, onDuplicate, onMoveToBox }: {
    workspaceMenu: ReactNode
    agents: DesktopAgentView[]
    statuses: Record<string, BoardActivityStatus>
    previews: DesktopCoworkerPreviews['previews'] | null
    selectedId: string | null
    foremanOpen: boolean
    disabled?: boolean
    onOpenCoworker: (agentId: string) => void
    onOpenCard?: (agentId: string) => void
    // The board's Actions inbox is shown here while the list hides the board.
    inboxSlot?: (element: HTMLElement | null) => void
    // Coworkers with a finished run nobody has opened yet.
    unseenIds?: readonly string[]
    // The Boxes of the board and the one a coworker sits in, for Move to Box.
    boxes?: readonly { id: string; name: string | null }[]
    boxOf?: (agentId: string) => string | null
    // Both need the grid: a copy is placed on it, a move lands in the first free cell of the Box.
    onDuplicate?: (agentId: string) => void
    onMoveToBox?: (agentId: string, spaceId: string) => void
    onOpenForeman?: () => void
    onSearch?: () => void
    onNewCoworker: () => void
}) {
    const { t, language } = useDesktopLocale()
    const ordered = useMemo(() => agents.map(agent => ({ agent, latest: previews?.[agent.id] ?? null })).sort(byRecency), [agents, previews])
    const [listElement, setListElement] = useState<HTMLElement | null>(null)
    const listFade = useScrollFade(listElement)
    const newCoworker = t('workspaceView.newCoworker')

    return <aside data-testid="desktop-simple-sidebar" className="flex h-full min-h-0 w-full flex-col">
        {/* Narrow enough that the menu's provider status folds to its icon and the workspace keeps its name. */}
        <div className="@container/board-header flex h-14 shrink-0 items-center border-b border-border px-2">{workspaceMenu}</div>
        {onSearch && <div className="px-3 pt-2">
            <button type="button" disabled={disabled} onClick={onSearch} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50">
                <Search className="size-4 shrink-0" />
                <span className="truncate">{t('workspaceView.list.search')}</span>
            </button>
        </div>}
        {inboxSlot && <div ref={inboxSlot} data-testid="desktop-simple-inbox" className="flex px-3 pt-1 empty:hidden" />}
        <div className="flex items-center justify-between gap-2 pt-3 pr-3 pb-1 pl-5">
            <h2 className="text-xs font-medium text-muted-foreground">{t('workspaceView.list.label')}</h2>
            <TooltipLabeled label={newCoworker}>
                <Button variant="ghost" size="icon-sm" aria-label={newCoworker} disabled={disabled} onClick={onNewCoworker}><Plus className="size-4" /></Button>
            </TooltipLabeled>
        </div>
        {/* The list fades at the edge it can still scroll past and stays sharp at the one it has reached (upstream #236). */}
        <nav ref={setListElement} aria-label={t('workspaceView.list.label')} data-testid="desktop-simple-list" className="min-h-0 flex-1 overflow-y-auto px-2" style={{ maskImage: listFade, WebkitMaskImage: listFade }}>
            <div className="space-y-0.5 pb-2">
            {onOpenForeman && <button type="button" disabled={disabled} aria-current={foremanOpen ? 'true' : undefined} onClick={onOpenForeman}
                className={cn('flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors', foremanOpen ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}>
                <span className="flex size-8 shrink-0 items-center justify-center"><Orb size={26} state="idle" facing="right" /></span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t('workspaceView.foreman.name')}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t('workspaceView.foreman.line')}</span>
                </span>
            </button>}
            {ordered.length === 0 ? <div className="flex flex-col items-center gap-3 px-3 py-10 text-center text-sm text-muted-foreground">
                <Users className="size-6" />
                {t('workspaceView.list.empty')}
                <Button size="sm" disabled={disabled} onClick={onNewCoworker}><Plus className="size-4" />{newCoworker}</Button>
            </div> : <ul className="space-y-0.5">
                {ordered.map(({ agent, latest }) => <li key={agent.id}>
                    <DesktopCoworkerTile agent={agent} status={statuses[agent.id]} latest={latest} selected={agent.id === selectedId} unseen={!!unseenIds?.includes(agent.id)} disabled={disabled}
                        onOpen={() => onOpenCoworker(agent.id)}
                        actions={onOpenCard && { onOpenCard: () => onOpenCard(agent.id), onDuplicate: onDuplicate && (() => onDuplicate(agent.id)),
                            onMoveToBox: onMoveToBox && (spaceId => onMoveToBox(agent.id, spaceId)), otherBoxes: boxes?.filter(box => box.id !== boxOf?.(agent.id)) }} />
                </li>)}
            </ul>}
            </div>
        </nav>
    </aside>
}
