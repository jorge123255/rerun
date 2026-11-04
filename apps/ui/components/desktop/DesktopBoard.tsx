import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChromeBar, ChromeButton, ChromeDivider } from '@rerun/ui/chrome'
import type { GridPosition, TileStyle } from '@rerun/ui/iso-grid'
import { IsoGrid, SPACE_COLOR, agentTileStyle, type Container, type Tile } from '@rerun/ui/iso-grid'
import { Plus } from 'lucide-react'
import type { DesktopAgentView } from './DesktopApp'
import { useBoardActivity } from './useBoardActivity'
import type { BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { DesktopBoardMenu } from './DesktopBoardMenu'
import { DesktopFindChat } from './DesktopFindChat'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { duplicateAgentName } from '@/lib/copy-name'
import { canPlaceDesktopCopy, desktopBoardLayout } from '@/lib/desktop/board-layout'

const ACTIVITY_LABEL: Record<BoardActivityStatus, string> = { working: 'Working', idle: 'Idle', unreachable: 'Activity unavailable', unknown: 'Checking activity' }

type CopyPlacement = {
    sourceId: string
    name: string
    requestId: string
    position?: GridPosition
    saving?: boolean
    error?: string
}

export function DesktopBoard({ agents, workspaceName, workspaceMenu, selectedAgentId, panelInsetRight = 0, onOpen, onCreate, onDismiss, onOpenConversation, onRename, onDuplicate }: {
    agents: DesktopAgentView[]
    workspaceName: string
    workspaceMenu?: ReactNode
    selectedAgentId?: string | null
    panelInsetRight?: number
    onOpen: (id: string) => void
    onRename?: (id: string, name: string) => Promise<void>
    onDuplicate?: (sourceId: string, requestId: string, position: GridPosition) => Promise<'created' | 'occupied'>
    onCreate: () => void
    onDismiss?: () => void
    onOpenConversation?: (hit: DesktopConversationHit) => void
}) {
    const activity = useBoardActivity(useMemo(() => agents.map(agent => agent.id), [agents]))
    const [placement, setPlacement] = useState<CopyPlacement | null>(null)
    const submitting = useRef(false)
    const section = useRef<HTMLElement>(null)
    const placeButton = useRef<HTMLButtonElement>(null)
    const layout = useMemo(() => desktopBoardLayout(agents), [agents])
    const { tiles, box } = useMemo(() => {
        const tiles: Tile[] = agents.map(agent => ({
            id: agent.id,
            position: layout.positions.get(agent.id)!,
            span: 2,
            containerId: 'team',
            style: tileStyle(activity[agent.id] ?? 'unknown', agent.name),
            ariaLabel: `Open chat with ${agent.name}`,
        }))
        const box: Container = {
            id: 'team', label: agents.length ? workspaceName : null, color: SPACE_COLOR,
            ...layout.bounds,
            variant: agents.length ? 'default' : 'placeholder',
            placeholderLabel: 'Create your first coworker',
        }
        return { tiles, box }
    }, [agents, workspaceName, activity, layout])

    useEffect(() => { if (placement?.requestId) placeButton.current?.focus({ preventScroll: true }) }, [placement?.requestId])

    function beginCopy(agent: DesktopAgentView) {
        if (placement) return
        onDismiss?.()
        setPlacement({ sourceId: agent.id, requestId: crypto.randomUUID(), name: duplicateAgentName(agent.name) })
    }

    function cancelCopy() {
        if (!placement || submitting.current) return
        Array.from(section.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
            .find(tile => tile.dataset.tileId === placement.sourceId)?.focus({ preventScroll: true })
        setPlacement(null)
    }

    async function placeCopy(position: GridPosition) {
        if (!onDuplicate || !placement || submitting.current) return
        // A lost response can follow a successful copy. Retry the same operation at the
        // same position until the server confirms it or rejects the unreserved position.
        const anchor = placement.position ?? position
        if (!placement.position && !canPlaceDesktopCopy(layout, anchor)) return
        submitting.current = true
        setPlacement({ ...placement, position: anchor, saving: true, error: undefined })
        try {
            const result = await onDuplicate(placement.sourceId, placement.requestId, anchor)
            setPlacement(result === 'created' ? null : { ...placement, position: undefined, saving: false, error: 'That spot is no longer available. Choose another.' })
        } catch (error) {
            setPlacement({ ...placement, position: anchor, saving: false,
                error: error instanceof Error ? error.message : 'Could not confirm the copy. Try again.' })
        } finally {
            submitting.current = false
        }
    }

    return (
        <section ref={section} aria-label="Team board" className="relative isolate min-h-0 min-w-0 flex-1"
            onKeyDown={event => { if (event.key === 'Escape' && placement) { event.preventDefault(); cancelCopy() } }}>
            <h1 className="sr-only">Team board</h1>
            <DesktopBoardMenu agents={agents} onOpen={onOpen} onRename={onRename} onDuplicate={onDuplicate ? beginCopy : undefined} disabled={!!placement}>{onTileContextMenu =>
                <IsoGrid
                    tiles={tiles}
                    containers={[box]}
                    onTileContextMenu={placement ? undefined : onTileContextMenu}
                    placing={!!placement && !placement.position}
                    placingTile={placement ? { span: 2, style: agentTileStyle('idle', placement.name) } : undefined}
                    onConfirmPlacement={placement && !placement.position ? placeCopy : undefined}
                    selectedTileId={selectedAgentId}
                    frameInset={{ left: 0, right: panelInsetRight }}
                    fitToContent
                    canDraw={false}
                    showViewControls={tiles.length > 0}
                    viewControlsPlacement="top-right"
                    viewControlsClassName={selectedAgentId ? 'md:top-auto md:right-auto md:bottom-16 md:left-4' : undefined}
                    onTileSelect={placement ? undefined : id => {
                        if (id) onOpen(id)
                        else if (selectedAgentId) onDismiss?.()
                    }}
                    onContainerSelect={tiles.length ? undefined : id => { if (id) onCreate() }}
                />
            }</DesktopBoardMenu>
            <div className="absolute top-4 left-4 z-40 flex items-start gap-2">{workspaceMenu}</div>
            <ChromeBar className="absolute bottom-4 left-4 z-40 max-w-[calc(100%-2rem)]" aria-label="Board actions" role="group">
                {placement ? <div className="flex min-w-0 items-center gap-2 pl-3">
                    <div className="min-w-0" role="status">
                        <Shimmer as="span" duration={1.6} className="block truncate text-sm font-medium">
                            {placement.saving ? `Placing ${placement.name}…` : `Tap a tile to place ${placement.name}`}
                        </Shimmer>
                        {placement.error && <p className="text-xs text-destructive" role="alert">{placement.error}</p>}
                    </div>
                    <ChromeButton ref={placeButton} label={placement.position && !placement.saving ? 'Retry' : 'Place copy'} disabled={placement.saving}
                        onClick={() => void placeCopy(layout.suggested)} />
                    <ChromeButton label="Cancel" disabled={placement.saving} onClick={cancelCopy} />
                </div> : <>
                    {onOpenConversation && <><DesktopFindChat onSelect={onOpenConversation} /><ChromeDivider /></>}
                    <ChromeButton icon={Plus} label="Add coworker" onClick={onCreate} />
                </>}
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
