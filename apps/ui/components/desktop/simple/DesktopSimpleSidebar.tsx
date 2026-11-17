'use client'

import { byRecency } from '@rerun/contracts'
import { Orb } from '@rerun/ui/foreman'
import { Box, Plus, Search, Users } from 'lucide-react'
import { useScrollFade } from '@rerun/ui/primitives'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopCoworkerPreviews } from '@/lib/desktop/coworker-previews'
import { desktopSidebarSections, type DesktopSidebarDrop, type DesktopSidebarList } from '@/lib/desktop/workspace-view'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from '../DesktopApp'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopCoworkerTile } from './DesktopCoworkerTile'
import { DesktopSidebarBoxList } from './DesktopSidebarBoxList'
import type { DesktopBoxDialogKind } from './DesktopSidebarBoxSection'

/**
 * The left column of the Simple view: the workspace, search, then the Chief of Staff and the
 * coworkers by Box (upstream #279). Without the board's Boxes to read, it falls back to one tile per
 * coworker, the most recently active first.
 */
export function DesktopSimpleSidebar({ workspaceMenu, agents, statuses, previews, selectedId, foremanOpen, disabled = false, onOpenCoworker, onOpenCard, onOpenForeman, onSearch, onNewCoworker, inboxSlot, unseenIds, boxes, boxOf, onDuplicate, onMoveToBox, collapsed, order, onToggleBox, onNewBox, onBoxDialog, onArrange }: {
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
    // The Boxes folded away, kept with the workspace.
    collapsed?: readonly string[]
    // Where someone dragged the Boxes and their coworkers; absent, things follow the order they were made.
    order?: Pick<DesktopSidebarList, 'boxes' | 'agents'>
    onToggleBox?: (boxId: string) => void
    // Both open the board's own dialogs; left out where the board cannot change its Boxes.
    onNewBox?: () => void
    onBoxDialog?: (kind: DesktopBoxDialogKind, boxId: string) => void
    // The list was dragged: where Boxes or coworkers now sit, or a coworker dropped in another Box
    // (which also needs onMoveToBox). Left out, nothing can be picked up.
    onArrange?: (drop: DesktopSidebarDrop) => void
    onOpenForeman?: () => void
    onSearch?: () => void
    onNewCoworker: () => void
}) {
    const { t, language } = useDesktopLocale()
    const ordered = useMemo(() => agents.map(agent => ({ agent, latest: previews?.[agent.id] ?? null })).sort(byRecency), [agents, previews])
    const grouped = useMemo(() => boxes ? desktopSidebarSections(agents, boxes, id => boxOf?.(id) ?? null, order) : null, [agents, boxes, boxOf, order])
    const newBox = t('workspaceView.list.newBox')
    const newCoworker = t('workspaceView.newCoworker')
    const tile = (agent: DesktopAgentView) => <DesktopCoworkerTile agent={agent} status={statuses[agent.id]} latest={previews?.[agent.id] ?? null} selected={agent.id === selectedId} unseen={!!unseenIds?.includes(agent.id)} disabled={disabled}
        onOpen={() => onOpenCoworker(agent.id)}
        actions={onOpenCard && { onOpenCard: () => onOpenCard(agent.id), onDuplicate: onDuplicate && (() => onDuplicate(agent.id)),
            onMoveToBox: onMoveToBox && (spaceId => onMoveToBox(agent.id, spaceId)), otherBoxes: boxes?.filter(box => box.id !== boxOf?.(agent.id)) }} />
    const empty = <div className="flex flex-col items-center gap-3 px-3 py-10 text-center text-sm text-muted-foreground">
        <Users className="size-6" />
        {t('workspaceView.list.empty')}
        <Button size="sm" disabled={disabled} onClick={onNewCoworker}><Plus className="size-4" />{newCoworker}</Button>
    </div>
    const [listElement, setListElement] = useState<HTMLElement | null>(null)
    const listFade = useScrollFade(listElement)

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
        <div className="flex items-center gap-1 pt-3 pr-3 pb-1 pl-5">
            <h2 className="text-xs font-medium text-muted-foreground">{t('workspaceView.list.label')}</h2>
            <span className="flex-1" />
            {onNewBox && <TooltipLabeled label={newBox}>
                <Button variant="ghost" size="icon-sm" aria-label={newBox} disabled={disabled} onClick={onNewBox}><Box className="size-4" /></Button>
            </TooltipLabeled>}
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
            {/* With several Boxes and no coworker the Boxes are still listed: one just created is not hidden (upstream #283). */}
            {grouped ? agents.length === 0 && grouped.sections.length <= 1 ? empty : <>
                <DesktopSidebarBoxList sections={grouped.sections} order={order} collapsed={collapsed ?? []} disabled={disabled}
                    waitingIn={members => members.some(agent => agent.enabled !== false && statuses[agent.id] === 'waiting_human')}
                    onToggle={boxId => onToggleBox?.(boxId)} onDialog={onBoxDialog} renderTile={tile} onDrop={onArrange} canMoveBetweenBoxes={!!onMoveToBox} />
                {/* A coworker the board has in no Box is still listed, after the Boxes. */}
                {grouped.loose.length > 0 && <ul data-simple-loose className="space-y-0.5">{grouped.loose.map(agent => <li key={agent.id}>{tile(agent)}</li>)}</ul>}
            </> : ordered.length === 0 ? empty : <ul className="space-y-0.5">
                {ordered.map(({ agent }) => <li key={agent.id}>{tile(agent)}</li>)}
            </ul>}
            </div>
        </nav>
    </aside>
}
