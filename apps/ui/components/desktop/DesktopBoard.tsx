import { useMemo, type ReactNode } from 'react'
import { ChromeBar, ChromeButton, ChromeDivider } from '@rerun/ui/chrome'
import type { TileStyle } from '@rerun/ui/iso-grid'
import { IsoGrid, SPACE_COLOR, agentTileStyle, type Container, type Tile } from '@rerun/ui/iso-grid'
import { Plus } from 'lucide-react'
import type { DesktopAgentView } from './DesktopApp'
import { useBoardActivity } from './useBoardActivity'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { DesktopFindChat } from './DesktopFindChat'

const ACTIVITY_LABEL: Record<BoardActivityStatus, string> = { working: 'Working', idle: 'Idle', unreachable: 'Activity unavailable', unknown: 'Checking activity' }

export function DesktopBoard({ agents, workspaceName, workspaceMenu, selectedAgentId, panelInsetRight = 0, onOpen, onCreate, onDismiss, onOpenConversation }: {
    agents: DesktopAgentView[]
    workspaceName: string
    workspaceMenu?: ReactNode
    selectedAgentId?: string | null
    panelInsetRight?: number
    onOpen: (id: string) => void
    onCreate: () => void
    onDismiss?: () => void
    onOpenConversation?: (hit: DesktopConversationHit) => void
}) {
    const activity = useBoardActivity(useMemo(() => agents.map(agent => agent.id), [agents]))
    const { tiles, box } = useMemo(() => {
        const columns = Math.max(1, Math.ceil(Math.sqrt(agents.length)))
        const rows = Math.max(1, Math.ceil(agents.length / columns))
        const tiles: Tile[] = agents.map((agent, index) => ({
            id: agent.id,
            position: { col: 3 + (index % columns) * 3, row: 3 + Math.floor(index / columns) * 3 },
            span: 2,
            containerId: 'team',
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
        <section aria-label="Team board" className="relative isolate min-h-0 min-w-0 flex-1">
            <h1 className="sr-only">Team board</h1>
            <div className="absolute inset-0">
                <IsoGrid
                    tiles={tiles}
                    containers={[box]}
                    selectedTileId={selectedAgentId}
                    frameInset={{ left: 0, right: panelInsetRight }}
                    fitToContent
                    canDraw={false}
                    showViewControls={tiles.length > 0}
                    viewControlsPlacement="top-right"
                    viewControlsClassName={selectedAgentId ? 'md:top-auto md:right-auto md:bottom-16 md:left-4' : undefined}
                    onTileSelect={id => {
                        if (id) onOpen(id)
                        else if (selectedAgentId) onDismiss?.()
                    }}
                    onContainerSelect={tiles.length ? undefined : id => { if (id) onCreate() }}
                />
            </div>
            <div className="absolute top-4 left-4 z-40 flex items-start gap-2">{workspaceMenu}</div>
            <ChromeBar className="absolute bottom-4 left-4 z-40" aria-label="Board actions" role="group">
                {onOpenConversation && <><DesktopFindChat onSelect={onOpenConversation} /><ChromeDivider /></>}
                <ChromeButton icon={Plus} label="Add coworker" onClick={onCreate} />
            </ChromeBar>
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
