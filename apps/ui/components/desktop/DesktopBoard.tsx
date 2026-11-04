import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChromeBar, ChromeButton, ChromeDivider } from '@rerun/ui/chrome'
import type { GridPosition, TileStyle } from '@rerun/ui/iso-grid'
import { IsoGrid, SPACE_COLOR, agentTileStyle, disabledAgentTileStyle, DISABLED_AGENT_LABEL, type Container, type Tile } from '@rerun/ui/iso-grid'
import { Plus } from 'lucide-react'
import type { DesktopAgentView } from './DesktopApp'
import { useBoardActivity } from './useBoardActivity'
import { latestBoardAttention, type BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { DesktopBoardMenu } from './DesktopBoardMenu'
import { DesktopFindChat } from './DesktopFindChat'
import { DesktopActionsInbox } from './DesktopActionsInbox'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { duplicateAgentName } from '@/lib/copy-name'
import { canPlaceDesktopCopy, desktopBoardLayout } from '@/lib/desktop/board-layout'

const ACTIVITY_LABEL: Record<BoardActivityStatus, string> = { working: 'Working', waiting_human: 'Needs you', idle: 'Idle', unreachable: 'Activity unavailable', unknown: 'Checking activity' }

type CopyPlacement = {
    sourceId: string
    name: string
    requestId: string
    position?: GridPosition
    saving?: boolean
    error?: string
}

export function DesktopBoard({ agents, workspaceName, workspaceMenu, selectedAgentId, panelInsetRight = 0, onOpen, onCreate, onDismiss, onOpenConversation, onRename, onDuplicate, onSetEnabled, onDelete, onPlacementChange }: {
    agents: DesktopAgentView[]
    workspaceName: string
    workspaceMenu?: ReactNode
    selectedAgentId?: string | null
    panelInsetRight?: number
    onOpen: (id: string) => void
    onRename?: (id: string, name: string) => Promise<void>
    onDuplicate?: (sourceId: string, requestId: string, position: GridPosition) => Promise<'created' | 'occupied'>
    onSetEnabled?: (id: string, enabled: boolean) => Promise<void>
    onDelete?: (id: string, confirmationName: string) => Promise<void>
    onCreate: () => void
    onDismiss?: () => void
    onOpenConversation?: (hit: DesktopConversationHit) => void
    onPlacementChange?: (placing: boolean) => void
}) {
    const { statuses: activity, attention } = useBoardActivity(useMemo(() => agents.map(agent => agent.id), [agents]))
    const openState = useRef({ agents, activity, attention, onOpen, onOpenConversation })
    openState.current = { agents, activity, attention, onOpen, onOpenConversation }
    const attentionCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const item of attention.items) counts.set(item.agentId, (counts.get(item.agentId) ?? 0) + 1)
        return counts
    }, [attention])
    const [placement, setPlacement] = useState<CopyPlacement | null>(null)
    const placing = !!placement
    useEffect(() => { onPlacementChange?.(placing) }, [placing, onPlacementChange])
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
            style: agent.enabled === false ? disabledAgentTileStyle(agent.name) : tileStyle(activity[agent.id] ?? 'unknown', agent.name, attentionCounts.get(agent.id) ?? 0),
            ariaLabel: `Open chat with ${agent.name}${attentionCounts.has(agent.id) ? ', Needs you' : ''}`,
        }))
        const box: Container = {
            id: 'team', label: agents.length ? workspaceName : null, color: SPACE_COLOR,
            ...layout.bounds,
            variant: agents.length ? 'default' : 'placeholder',
            placeholderLabel: 'Create your first coworker',
        }
        return { tiles, box }
    }, [agents, workspaceName, activity, attentionCounts, layout])

    useEffect(() => { if (placement?.requestId) placeButton.current?.focus({ preventScroll: true }) }, [placement?.requestId])

    function openCoworker(id: string) {
        const { agents, activity, attention, onOpen, onOpenConversation } = openState.current
        const agent = agents.find(agent => agent.id === id)
        if (!agent) return
        const status = activity[id]
        const target = status && status !== 'unknown' && status !== 'unreachable' ? latestBoardAttention(attention, id) : undefined
        if (target && onOpenConversation) onOpenConversation({ id: target.sessionId, agentId: agent.id, agentName: agent.name, title: target.title })
        else onOpen(id)
    }

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
            <DesktopBoardMenu agents={agents} onOpen={openCoworker} onRename={onRename} onDuplicate={onDuplicate ? beginCopy : undefined}
                onSetEnabled={onSetEnabled} onDelete={onDelete} disabled={!!placement}>{onTileContextMenu =>
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
                        if (id) openCoworker(id)
                        else if (selectedAgentId) onDismiss?.()
                    }}
                    onContainerSelect={tiles.length ? undefined : id => { if (id) onCreate() }}
                />
            }</DesktopBoardMenu>
            <div className="absolute top-4 left-4 z-40 flex items-start gap-2">{workspaceMenu}</div>
            <div className="absolute bottom-4 left-4 z-40 flex max-w-[calc(100%-2rem)] flex-wrap items-end gap-2">
            {!placement && onOpenConversation && <DesktopActionsInbox agents={agents} onOpenConversation={onOpenConversation} />}
            <ChromeBar aria-label="Board actions" role="group">
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
            </div>
            <ul aria-label="Coworker activity" className="sr-only" aria-live="polite">
                {agents.map(agent => {
                    const status = agent.enabled === false ? 'inactive' : activity[agent.id] ?? 'unknown'
                    return <li key={agent.id} data-board-activity={agent.name} data-status={status}>{agent.name}: {status === 'inactive' ? DISABLED_AGENT_LABEL : ACTIVITY_LABEL[status]}{status !== 'waiting_human' && attentionCounts.has(agent.id) ? '; Needs you' : ''}</li>
                })}
            </ul>
        </section>
    )
}

// Rerun's agentTileStyle: working shimmers amber, a failed read uses the offline tile with an honest label.
function tileStyle(status: BoardActivityStatus, name: string, attentionCount: number): TileStyle {
    if (status === 'working' || status === 'waiting_human') return agentTileStyle(status, name, attentionCount)
    if (status === 'unreachable' || status === 'unknown') {
        const style = agentTileStyle('offline', name)
        return { ...style, status: { label: ACTIVITY_LABEL[status], tone: style.status?.tone ?? 'neutral' } }
    }
    return agentTileStyle('idle', name)
}
