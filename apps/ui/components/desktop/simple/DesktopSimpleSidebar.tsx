'use client'

import { byRecency, coworkerLine, type AgentStatus, type CoworkerLineKey, type CoworkerLineTone } from '@rerun/contracts'
import { shortRelativeTime } from '@rerun/i18n/format'
import { Orb } from '@rerun/ui/foreman'
import { AgentBuddy, buddyMoodOfStatus } from '@rerun/ui/iso-grid'
import { Plus, Search, Users } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopCoworkerPreviews } from '@/lib/desktop/coworker-previews'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from '../DesktopApp'
import { useDesktopLocale } from '../DesktopLocale'

const LINE_TONE: Record<CoworkerLineTone, string> = { muted: 'text-muted-foreground', waiting: 'text-orange-500', destructive: 'text-destructive' }

// A failed read never reads as an error of the coworker's, and never as work in progress.
function statusOf(status: BoardActivityStatus | undefined): AgentStatus {
    return status === 'working' || status === 'waiting_human' ? status : 'idle'
}

/**
 * The left column of the Simple view: the workspace, search, then the Chief of Staff and one tile
 * per coworker, the most recently active first.
 */
export function DesktopSimpleSidebar({ workspaceMenu, agents, statuses, previews, selectedId, foremanOpen, disabled = false, onOpenCoworker, onOpenForeman, onSearch, onNewCoworker }: {
    workspaceMenu: ReactNode
    agents: DesktopAgentView[]
    statuses: Record<string, BoardActivityStatus>
    previews: DesktopCoworkerPreviews['previews'] | null
    selectedId: string | null
    foremanOpen: boolean
    disabled?: boolean
    onOpenCoworker: (agentId: string) => void
    onOpenForeman?: () => void
    onSearch?: () => void
    onNewCoworker: () => void
}) {
    const { t, language } = useDesktopLocale()
    const ordered = useMemo(() => agents.map(agent => ({ agent, latest: previews?.[agent.id] ?? null })).sort(byRecency), [agents, previews])
    const newCoworker = t('workspaceView.newCoworker')

    return <aside data-testid="desktop-simple-sidebar" className="flex h-full min-h-0 w-full flex-col">
        <div className="flex h-14 shrink-0 items-center border-b border-border px-2">{workspaceMenu}</div>
        {onSearch && <div className="px-3 pt-2">
            <button type="button" disabled={disabled} onClick={onSearch} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50">
                <Search className="size-4 shrink-0" />
                <span className="truncate">{t('workspaceView.list.search')}</span>
            </button>
        </div>}
        <div className="flex items-center justify-between gap-2 pt-3 pr-3 pb-1 pl-5">
            <h2 className="text-xs font-medium text-muted-foreground">{t('workspaceView.list.label')}</h2>
            <TooltipLabeled label={newCoworker}>
                <Button variant="ghost" size="icon-sm" aria-label={newCoworker} disabled={disabled} onClick={onNewCoworker}><Plus className="size-4" /></Button>
            </TooltipLabeled>
        </div>
        <nav aria-label={t('workspaceView.list.label')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
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
                {ordered.map(({ agent, latest }) => {
                    const paused = agent.enabled === false
                    const status = statusOf(statuses[agent.id])
                    const line = coworkerLine({ status, paused, description: agent.description || null, latest },
                        (key: CoworkerLineKey, values) => t(`workspaceView.${key}`, values))
                    const selected = agent.id === selectedId
                    return <li key={agent.id}>
                        <div className={cn('group relative flex items-center rounded-lg transition-colors', selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}>
                            <button type="button" disabled={disabled} data-simple-tile-id={agent.id} onClick={() => onOpenCoworker(agent.id)} aria-current={selected ? 'true' : undefined}
                                className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 pl-2 text-left">
                                <AgentBuddy agentId={agent.id} mood={buddyMoodOfStatus(status, paused)} size={32} facing="right" className="shrink-0" />
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-baseline gap-2">
                                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
                                        {latest && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{shortRelativeTime(latest.updatedAt, language.locale)}</span>}
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <span className={cn('min-w-0 flex-1 truncate text-xs', LINE_TONE[line.tone])}>{line.text || ' '}</span>
                                        {!paused && status === 'waiting_human' && <span className="size-2 shrink-0 rounded-full bg-orange-400" />}
                                    </span>
                                </span>
                            </button>
                        </div>
                    </li>
                })}
            </ul>}
        </nav>
    </aside>
}
