import { useMemo } from 'react'
import type { TileStyle } from '@rerun/ui/iso-grid'
import { IsoGrid, SPACE_COLOR, agentTileStyle, type Container, type Tile } from '@rerun/ui/iso-grid'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DesktopAgentView } from './DesktopApp'
import { useBoardActivity } from './useBoardActivity'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { DesktopFindChat } from './DesktopFindChat'

const ACTIVITY_LABEL: Record<BoardActivityStatus, string> = { working: 'Working', idle: 'Idle', unreachable: 'Activity unavailable', unknown: 'Checking activity' }

export function DesktopBoard({ agents, workspaceName, onOpen, onCreate, onOpenConversation }: {
    agents: DesktopAgentView[]
    workspaceName: string
    onOpen: (id: string) => void
    onCreate: () => void
    onOpenConversation?: (hit: DesktopConversationHit) => void
}) {
    const activity = useBoardActivity(useMemo(() => agents.map(agent => agent.id), [agents]))
    const { tiles, box } = useMemo(() => {
        const columns = Math.max(1, Math.ceil(Math.sqrt(agents.length)))
        const rows = Math.max(1, Math.ceil(agents.length / columns))
        const tiles: Tile[] = agents.map((agent, index) => ({
            id: agent.id,
            position: { col: 3 + (index % columns) * 3, row: 3 + Math.floor(index / columns) * 3 },
            style: tileStyle(activity[agent.id] ?? 'unknown', agent.name),
            ariaLabel: `Open chat with ${agent.name}`,
        }))
        const box: Container = {
            id: 'team', label: agents.length ? workspaceName : null, color: SPACE_COLOR,
            col_start: 1, row_start: 1, col_end: 3 * columns + 2, row_end: 3 * rows + 2,
            variant: agents.length ? 'default' : 'placeholder',
            placeholderLabel: 'Create your first coworker',
        }
        return { tiles, box }
    }, [agents, workspaceName, activity])

    return (
        <section aria-label="Team board" className="flex min-h-64 flex-1 flex-col">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                <div>
                    <h1 className="text-lg font-semibold tracking-tight">Team board</h1>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                        {agents.length ? 'Select a coworker to open their chat.' : 'Give your first coworker a name and a job.'}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {onOpenConversation && <DesktopFindChat onSelect={onOpenConversation} />}
                    <Button type="button" size="sm" onClick={onCreate}><Plus aria-hidden />Add coworker</Button>
                </div>
            </header>
            <div className="relative min-h-48 flex-1">
                <IsoGrid
                    tiles={tiles}
                    containers={[box]}
                    fitToContent
                    canDraw={false}
                    showViewControls={tiles.length > 0}
                    onTileSelect={id => { if (id) onOpen(id) }}
                    onContainerSelect={tiles.length ? undefined : id => { if (id) onCreate() }}
                />
            </div>
            <ul aria-label="Coworker activity" className="sr-only" aria-live="polite">
                {agents.map(agent => {
                    const status = activity[agent.id] ?? 'unknown'
                    return <li key={agent.id} data-board-activity={agent.name} data-status={status}>{agent.name}: {ACTIVITY_LABEL[status]}</li>
                })}
            </ul>
        </section>
    )
}

// Rerun's agentTileStyle: working shimmers amber, a failed read uses the offline tile with an honest label.
function tileStyle(status: BoardActivityStatus, name: string): TileStyle {
    if (status === 'working') return agentTileStyle('working', name)
    if (status === 'unreachable') {
        const style = agentTileStyle('offline', name)
        return { ...style, status: { label: ACTIVITY_LABEL.unreachable, tone: style.status?.tone ?? 'neutral' } }
    }
    return agentTileStyle('idle', name)
}
