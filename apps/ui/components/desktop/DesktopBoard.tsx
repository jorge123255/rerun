import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChromeBar, ChromeButton, ChromeDivider } from '@rerun/ui/chrome'
import type { ContainerCellRect, GridPosition, IsoCamera, ResizePatch, TileStyle } from '@rerun/ui/iso-grid'
import { IsoGrid, SPACE_COLOR, agentTileStyle, disabledAgentTileStyle, DISABLED_AGENT_LABEL, type Container, type Tile } from '@rerun/ui/iso-grid'
import { Plus } from 'lucide-react'
import type { DesktopAgentView } from './DesktopApp'
import type { DesktopCreationPlacement } from './useDesktopCreation'
import { templatePlacementBoard, type DesktopTemplatePlacement } from './templates/useDesktopTemplatePlacement'
import { useBoardActivity } from './useBoardActivity'
import { latestBoardAttention, type BoardActivityStatus, type BoardActivitySnapshot } from '@/lib/desktop/board-activity'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { DesktopBoardMenu } from './DesktopBoardMenu'
import { DesktopFindChat } from './DesktopFindChat'
import { DesktopActionsInbox } from './DesktopActionsInbox'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { duplicateAgentName } from '@/lib/copy-name'
import { canPlaceDesktopCopy, desktopBoardLayout } from '@/lib/desktop/board-layout'
import { freeRectOnSide } from '@/lib/board/space-layout'
import type { DesktopBoardState, DesktopSpaceCommand } from '@/lib/desktop/spaces'
import { isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { useBoardCoverStore } from '@/stores/board-cover.store'
import { Button } from '@/components/ui/button'
import { DesktopSpaceDialogs, type DesktopSpaceDialogTarget } from './DesktopSpaceDialogs'
import { desktopSpaceAt, desktopSpaceLabel, desktopSpaceRectAllowed, firstDesktopSpacePosition, previewDesktopSpace } from './desktop-space-layout'

const ACTIVITY_LABEL: Record<BoardActivityStatus, string> = { working: 'Working', waiting_human: 'Needs you', idle: 'Idle', unreachable: 'Activity unavailable', unknown: 'Checking activity' }

type CopyPlacement = {
    sourceId: string
    name: string
    requestId: string
    position?: GridPosition
    spaceId?: string
    saving?: boolean
    error?: string
}

export function DesktopBoard({ activitySnapshot, agents, workspaceName, workspaceMenu, selectedAgentId, visibleSessionId, panelInsetRight = 0, panelInsetLeft = 0, recenterSignal, newBoxSignal = 0, focusRequest, boxFocusRequest, onOpen, onCreate, onDismiss, onOpenConversation, onRename, onShare, onDuplicate, onSetEnabled, onDelete, onPlacementChange, board, onBoardCommand, boardSaving = false, boardError, boardDisabled = false, onBoardInteractionChange, onRetryBoard, newCoworker, onPlaceCoworker, onCancelCoworker, creationChecking = false, creationError, onRetryCreation, templatePlacement, onPlaceTemplate, onCancelTemplate, onReviewTemplate, cameraMountKey, initialCamera, onCameraChange }: {
    activitySnapshot?: BoardActivitySnapshot
    agents: DesktopAgentView[]
    workspaceName: string
    workspaceMenu?: ReactNode
    selectedAgentId?: string | null
    visibleSessionId?: string | null
    panelInsetRight?: number
    panelInsetLeft?: number
    recenterSignal?: number
    newBoxSignal?: number
    focusRequest?: { tileId: string; nonce: number; insetRight: number } | null
    boxFocusRequest?: { spaceId: string; nonce: number } | null
    onOpen: (id: string) => void
    onRename?: (id: string, name: string) => Promise<void>
    onShare?: (agent: DesktopAgentView) => void
    onDuplicate?: (sourceId: string, requestId: string, position: GridPosition, spaceId?: string) => Promise<'created' | 'occupied'>
    onSetEnabled?: (id: string, enabled: boolean) => Promise<void>
    onDelete?: (id: string, confirmationName: string) => Promise<void>
    onCreate: (spaceId?: string) => void
    onDismiss?: () => void
    onOpenConversation?: (hit: DesktopConversationHit) => void
    onPlacementChange?: (placing: boolean) => void
    board?: DesktopBoardState
    onBoardCommand?: (command: DesktopSpaceCommand) => Promise<void>
    boardSaving?: boolean
    boardError?: string
    boardDisabled?: boolean
    onBoardInteractionChange?: (active: boolean) => void
    onRetryBoard?: () => Promise<void>
    newCoworker?: DesktopCreationPlacement | null
    onPlaceCoworker?: (position: GridPosition, spaceId: string) => Promise<void>
    onCancelCoworker?: () => void
    creationChecking?: boolean
    creationError?: string
    onRetryCreation?: () => Promise<void>
    templatePlacement?: DesktopTemplatePlacement | null
    onPlaceTemplate?: (position: GridPosition, board: DesktopBoardState) => Promise<void>
    onCancelTemplate?: () => void
    onReviewTemplate?: () => void
    cameraMountKey?: string
    initialCamera?: IsoCamera | null
    onCameraChange?: (camera: IsoCamera) => void
}) {
    const localActivity = useBoardActivity(useMemo(() => agents.map(agent => agent.id), [agents]), !activitySnapshot)
    const { statuses: activity, attention } = activitySnapshot ?? localActivity
    const openState = useRef({ agents, activity, attention, onOpen, onOpenConversation })
    openState.current = { agents, activity, attention, onOpen, onOpenConversation }
    const attentionCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const item of attention.items) counts.set(item.agentId, (counts.get(item.agentId) ?? 0) + 1)
        return counts
    }, [attention])
    const [copyPlacement, setPlacement] = useState<CopyPlacement | null>(null)
    const placement: CopyPlacement | null = templatePlacement ? { sourceId: '', requestId: templatePlacement.id,
        name: templatePlacement.template.agents[Math.min(templatePlacement.positions.length, templatePlacement.template.agents.length - 1)]?.name ?? templatePlacement.template.title,
        position: templatePlacement.submitted ? templatePlacement.positions.at(-1) : undefined,
        spaceId: templatePlacement.spaceId, saving: templatePlacement.saving, error: templatePlacement.error,
    } : newCoworker ? { sourceId: '', requestId: newCoworker.intent.requestId, name: newCoworker.intent.name,
        position: newCoworker.position, spaceId: newCoworker.spaceId, saving: newCoworker.saving, error: newCoworker.error } : copyPlacement
    const [spaceDialog, setSpaceDialog] = useState<DesktopSpaceDialogTarget | null>(null)
    const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
    useEffect(() => { if (boxFocusRequest && board?.spaces.some(space => space.id === boxFocusRequest.spaceId)) setSelectedSpaceId(boxFocusRequest.spaceId) }, [boxFocusRequest, board])
    const [menuInteracting, setMenuInteracting] = useState(false)
    const [resizing, setResizing] = useState<string | null>(null)
    const [commandBusy, setCommandBusy] = useState(false)
    const [commandError, setCommandError] = useState('')
    type Preview = { revision: number; spaceId: string; rect: ContainerCellRect; moving: boolean }
    const [preview, setPreview] = useState<Preview | null>(null)
    const previewRef = useRef(preview)
    const resizeCanceled = useRef(false)
    const commandFlight = useRef<symbol | null>(null)
    const retryCommand = useRef<DesktopSpaceCommand | null>(null)
    const mounted = useRef(true)
    const quitting = useSyncExternalStore(subscribeDraftShutdown, isDesktopQuitting, () => false)
    const covered = useBoardCoverStore(state => state.covers > 0)
    const latestBoard = useRef({ board, onBoardCommand, boardDisabled, boardSaving, placement, spaceDialog, covered, newCoworker, onPlaceCoworker, onCancelCoworker, templatePlacement, onPlaceTemplate, onCancelTemplate })
    latestBoard.current = { board, onBoardCommand, boardDisabled, boardSaving, placement, spaceDialog, covered, newCoworker, onPlaceCoworker, onCancelCoworker, templatePlacement, onPlaceTemplate, onCancelTemplate }
    const interaction = !!spaceDialog || !!resizing || menuInteracting || commandBusy
    const interactionCallback = useRef(onBoardInteractionChange)
    interactionCallback.current = onBoardInteractionChange
    useEffect(() => { interactionCallback.current?.(interaction) }, [interaction])
    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; interactionCallback.current?.(false) }
    }, [])
    useEffect(() => {
        if (previewRef.current && previewRef.current.revision !== board?.revision) { previewRef.current = null; setPreview(null); setResizing(null) }
        if (board) {
            if (selectedSpaceId && !board.spaces.some(space => space.id === selectedSpaceId)) setSelectedSpaceId(null)
            if (spaceDialog && spaceDialog.kind !== 'create' && !board.spaces.some(space => space.id === spaceDialog.spaceId)) setSpaceDialog(null)
            if (spaceDialog?.kind === 'create' && spaceDialog.sourceId && !board.spaces.some(space => space.id === spaceDialog.sourceId)) setSpaceDialog(null)
        }
        setCommandError('')
    }, [board?.revision])
    const newBoxSeen = useRef(newBoxSignal)
    useEffect(() => {
        if (newBoxSeen.current === newBoxSignal) return
        // Let the command palette finish releasing its cover before opening the same
        // New Box form. A request is consumed once and cannot reopen after Cancel.
        if (covered && !quitting) return
        newBoxSeen.current = newBoxSignal
        if (!board || !onBoardCommand || boardDisabled || boardSaving || commandBusy || quitting || placement || spaceDialog) return
        setSpaceDialog({ kind: 'create' })
    }, [newBoxSignal, covered, board, onBoardCommand, boardDisabled, boardSaving, commandBusy, quitting, placement, spaceDialog])
    const baseBlocked = boardDisabled || boardSaving || commandBusy || quitting
    const gridBlocked = baseBlocked || !!spaceDialog || covered
    const boardRevision = board?.revision
    const gestureScope = JSON.stringify([boardRevision, boardDisabled, boardSaving, !!spaceDialog, covered, placement?.requestId, newCoworker?.spaceId, newCoworker?.position, templatePlacement?.positions, templatePlacement?.submitted])
    const gestureIdentity = useRef({ scope: gestureScope, generation: 0 })
    if (gestureIdentity.current.scope !== gestureScope) gestureIdentity.current = { scope: gestureScope, generation: gestureIdentity.current.generation + 1 }
    const gestureGeneration = gestureIdentity.current.generation
    const placing = !!placement
    useEffect(() => { onPlacementChange?.(placing) }, [placing, onPlacementChange])
    const submitting = useRef(false)
    const section = useRef<HTMLElement>(null)
    const placeButton = useRef<HTMLButtonElement>(null)
    const layout = useMemo(() => desktopBoardLayout(agents), [agents])
    const renderedBoard = useMemo(() => board && preview?.revision === board.revision ? previewDesktopSpace(board, preview.spaceId, preview.rect, preview.moving) : board, [board, preview])
    const { tiles, containers } = useMemo(() => {
        if (renderedBoard) {
            const memberships = new Map(renderedBoard.placements.map(placed => [placed.agentId, placed]))
            const tiles: Tile[] = agents.flatMap(agent => {
                const placed = memberships.get(agent.id)
                if (!placed || !renderedBoard.spaces.some(space => space.id === placed.spaceId)) return []
                return [{ id: agent.id, position: { col: placed.col, row: placed.row }, span: 2, containerId: placed.spaceId,
                    style: agent.enabled === false ? disabledAgentTileStyle(agent.name) : tileStyle(activity[agent.id] ?? 'unknown', agent.name, attentionCounts.get(agent.id) ?? 0),
                    ariaLabel: `Open chat with ${agent.name}${attentionCounts.has(agent.id) ? ', Needs you' : ''}` }]
            })
            const containers: Container[] = renderedBoard.spaces.length ? renderedBoard.spaces.map((space, index) => ({
                ...space, label: space.name, color: preview?.spaceId === space.id && board && !desktopSpaceRectAllowed(board, space.id, preview.rect, preview.moving) ? '#ef4444' : SPACE_COLOR,
                ariaLabel: desktopSpaceLabel(space, index, renderedBoard.spaces.length),
                ...(!renderedBoard.placements.some(placed => placed.spaceId === space.id) ? { cta: 'Add a coworker' } : {}),
            })) : [{ id: 'desktop-empty-box', label: null, color: SPACE_COLOR, col_start: 0, row_start: 0, col_end: 7, row_end: 7, variant: 'placeholder', placeholderLabel: 'Create your first Box' }]
            return { tiles, containers }
        }
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
        return { tiles, containers: [box] }
    }, [agents, workspaceName, activity, attentionCounts, layout, renderedBoard, preview, board])

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
        if (placement || baseBlocked || isDesktopQuitting()) return
        onDismiss?.()
        setPlacement({ sourceId: agent.id, requestId: crypto.randomUUID(), name: duplicateAgentName(agent.name) })
    }

    function cancelCopy() {
        if (!placement || submitting.current) return
        if (templatePlacement) {
            const live = latestBoard.current
            if (mounted.current && live.templatePlacement?.id === templatePlacement.id && !live.templatePlacement.submitted && !live.templatePlacement.saving) live.onCancelTemplate?.()
            return
        }
        if (newCoworker) {
            const live = latestBoard.current
            if (mounted.current && live.newCoworker?.intent.requestId === newCoworker.intent.requestId && !live.newCoworker.submitted && !live.newCoworker.saving) live.onCancelCoworker?.()
            return
        }
        Array.from(section.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
            .find(tile => tile.dataset.tileId === placement.sourceId)?.focus({ preventScroll: true })
        setPlacement(null)
    }

    async function placeCopy(position: GridPosition) {
        if (templatePlacement) {
            const live = latestBoard.current
            if (!mounted.current || !live.board || !live.onPlaceTemplate || submitting.current || live.templatePlacement?.id !== templatePlacement.id
                || gestureIdentity.current.generation !== gestureGeneration || live.board.revision !== boardRevision || live.templatePlacement.saving
                || live.boardDisabled || live.boardSaving || live.spaceDialog || live.covered || commandFlight.current || isDesktopQuitting()) return
            submitting.current = true
            try { await live.onPlaceTemplate(position, live.board) } finally { submitting.current = false }
            return
        }
        if (newCoworker) {
            const live = latestBoard.current
            if (!mounted.current || !live.onPlaceCoworker || submitting.current || live.newCoworker?.intent.requestId !== newCoworker.intent.requestId
                || gestureIdentity.current.generation !== gestureGeneration || live.board?.revision !== boardRevision || live.newCoworker.saving
                || live.boardDisabled || live.boardSaving || live.spaceDialog || live.covered || commandFlight.current || isDesktopQuitting()) return
            const anchor = newCoworker.position ?? position
            const destination = board ? desktopSpaceAt(board, anchor) : undefined
            if (!newCoworker.position && (!destination || newCoworker.spaceId && destination.id !== newCoworker.spaceId)) return
            const spaceId = newCoworker.spaceId ?? destination?.id
            if (!spaceId) return
            submitting.current = true
            try { await live.onPlaceCoworker(anchor, spaceId) } finally { submitting.current = false }
            return
        }
        if (!onDuplicate || !placement || submitting.current || boardDisabled || isDesktopQuitting()) return
        // A lost response can follow a successful copy. Retry the same operation at the
        // same position until the server confirms it or rejects the unreserved position.
        const anchor = placement.position ?? position
        const destination = board ? desktopSpaceAt(board, anchor) : undefined
        if (!placement.position && (board ? !destination : !canPlaceDesktopCopy(layout, anchor))) return
        const targetSpace = placement.spaceId ?? destination?.id
        submitting.current = true
        setPlacement({ ...placement, position: anchor, spaceId: targetSpace, saving: true, error: undefined })
        try {
            const result = targetSpace ? await onDuplicate(placement.sourceId, placement.requestId, anchor, targetSpace) : await onDuplicate(placement.sourceId, placement.requestId, anchor)
            if (mounted.current) setPlacement(result === 'created' ? null : { ...placement, position: undefined, spaceId: undefined, saving: false, error: 'That spot is no longer available. Choose another.' })
        } catch (error) {
            if (mounted.current) setPlacement({ ...placement, position: anchor, spaceId: targetSpace, saving: false,
                error: error instanceof Error ? error.message : 'Could not confirm the copy. Try again.' })
        } finally {
            submitting.current = false
        }
    }

    function gridCurrent() {
        const live = latestBoard.current
        return mounted.current && gestureIdentity.current.generation === gestureGeneration && live.board?.revision === boardRevision && !live.boardDisabled && !live.boardSaving && !commandFlight.current && !live.spaceDialog && !live.covered && !live.placement && !isDesktopQuitting()
    }
    async function command(value: DesktopSpaceCommand) {
        const live = latestBoard.current
        if (!mounted.current || !live.board || !live.onBoardCommand || live.boardDisabled || live.boardSaving || commandFlight.current || isDesktopQuitting()) throw new Error('Wait for the current board change to finish.')
        const token = Symbol('board command')
        commandFlight.current = token; retryCommand.current = value; setCommandBusy(true)
        try {
            await live.onBoardCommand(value)
            if (mounted.current && commandFlight.current === token) { retryCommand.current = null; setCommandError('') }
        } catch (error) {
            if (mounted.current && commandFlight.current === token) setCommandError(error instanceof Error ? error.message : 'Could not save the board. Try again.')
            throw error
        } finally {
            if (commandFlight.current === token) {
                commandFlight.current = null
                if (mounted.current) { setCommandBusy(false); previewRef.current = null; setPreview(null) }
            }
        }
    }
    function openBoxDialog(target: DesktopSpaceDialogTarget) {
        if (!gridCurrent() || !onBoardCommand) return
        setSpaceDialog(target)
    }
    function moveAgent(agentId: string, spaceId: string, position?: GridPosition) {
        if (!gridCurrent() || !board || !board.placements.some(placed => placed.agentId === agentId)) return Promise.resolve()
        const destination = position ? desktopSpaceAt(board, position, agentId) : firstDesktopSpacePosition(board, spaceId, agentId)
        if (!destination || (position && 'id' in destination && destination.id !== spaceId)) return Promise.resolve()
        return command({ kind: 'move-agent', agentId, spaceId, ...(position && { position }) })
    }
    function moveBox(spaceId: string, rect: ContainerCellRect) {
        if (!gridCurrent() || !board) return
        if (!desktopSpaceRectAllowed(board, spaceId, rect, true)) { setCommandError('That Box would overlap another Box. Choose another spot.'); return }
        const next = { revision: board.revision, spaceId, rect, moving: true }
        previewRef.current = next; setPreview(next)
        void command({ kind: 'move-space', spaceId, rect }).catch(() => {})
    }
    function resizeBox(spaceId: string, patch: ResizePatch) {
        if (!gridCurrent() || !board || resizeCanceled.current) return
        const source = board.spaces.find(space => space.id === spaceId)
        if (!source) return
        const rect = { col_start: source.col_start, row_start: source.row_start, col_end: source.col_end, row_end: source.row_end, ...(previewRef.current?.spaceId === spaceId ? previewRef.current.rect : {}), ...patch }
        const next = { revision: board.revision, spaceId, rect, moving: false }
        previewRef.current = next; setPreview(next)
    }
    function commitResize(spaceId: string) {
        const draft = previewRef.current
        if (!gridCurrent() || resizeCanceled.current || !board || !draft || draft.spaceId !== spaceId || draft.revision !== board.revision) { previewRef.current = null; setPreview(null); return }
        if (!desktopSpaceRectAllowed(board, spaceId, draft.rect, false)) {
            previewRef.current = null; setPreview(null); setCommandError('This Box must keep its coworkers inside and leave room for the other Boxes.'); return
        }
        void command({ kind: 'resize-space', spaceId, rect: draft.rect }).catch(() => {})
    }
    async function retryBoard() {
        if (baseBlocked || isDesktopQuitting()) return
        try {
            if (onRetryBoard) await onRetryBoard()
            else if (retryCommand.current) await command(retryCommand.current)
            if (mounted.current) setCommandError('')
        } catch (error) { if (mounted.current) setCommandError(error instanceof Error ? error.message : 'Could not refresh the board. Try again.') }
    }
    const suggestionBoard = board && templatePlacement ? templatePlacementBoard(board, templatePlacement) : board
    const suggestion = suggestionBoard ? firstDesktopSpacePosition(suggestionBoard, templatePlacement?.spaceId ?? newCoworker?.spaceId)?.position : newCoworker || templatePlacement ? undefined : layout.suggested
    const placedTemplateTiles: Tile[] = templatePlacement?.positions.map((position, index) => ({
        id: `template-placement-${templatePlacement.id}-${index}`, position, span: 2, containerId: templatePlacement.spaceId,
        style: agentTileStyle('idle', templatePlacement.template.agents[index]?.name ?? ''),
        ariaLabel: `Placed ${templatePlacement.template.agents[index]?.name ?? 'coworker'} in this template`,
    })) ?? []
    const canEditBoard = !!board && !!onBoardCommand && !gridBlocked && !placement
    function restoreBoxFocus() {
        if (!mounted.current || isDesktopQuitting()) return
        const id = spaceDialog?.kind === 'create' ? spaceDialog.sourceId : spaceDialog?.spaceId
        const spaces = latestBoard.current.board?.spaces ?? []
        const index = spaces.findIndex(space => space.id === id)
        const label = index >= 0 ? desktopSpaceLabel(spaces[index], index, spaces.length) : undefined
        const box = [...section.current?.querySelectorAll<HTMLElement>('[aria-label]') ?? []].find(element => element.getAttribute('aria-label') === label)
        const add = [...section.current?.querySelectorAll<HTMLButtonElement>('button') ?? []].find(button => button.textContent?.trim() === 'Add Box')
        ;(box ?? add)?.focus({ preventScroll: true })
    }

    return (
        <section ref={section} aria-label="Team board" className="relative isolate min-h-0 min-w-0 flex-1"
            onPointerDownCapture={() => { resizeCanceled.current = false }} onPointerCancelCapture={() => { resizeCanceled.current = true }}
            onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && placement) { event.preventDefault(); cancelCopy() } }}>
            <h1 className="sr-only">Team board</h1>
            <DesktopBoardMenu agents={agents} onOpen={openCoworker} onRename={onRename} onShare={onShare} onDuplicate={onDuplicate ? beginCopy : undefined}
                onSetEnabled={onSetEnabled} onDelete={onDelete} disabled={!!placement || gridBlocked}
                spaces={board} onRenameSpace={onBoardCommand ? spaceId => openBoxDialog({ kind: 'rename', spaceId }) : undefined}
                onDeleteSpace={onBoardCommand ? spaceId => openBoxDialog({ kind: 'delete', spaceId }) : undefined}
                onMoveAgent={onBoardCommand ? (agentId, spaceId) => moveAgent(agentId, spaceId) : undefined} onInteractionChange={setMenuInteracting}>
                {(onTileContextMenu, onContainerContextMenu) =>
                <IsoGrid
                    key={cameraMountKey}
                    initialCamera={initialCamera ?? undefined}
                    onCameraChange={onCameraChange}
                    tiles={placedTemplateTiles.length ? [...tiles, ...placedTemplateTiles] : tiles}
                    containers={containers}
                    onTileContextMenu={placement || gridBlocked ? undefined : onTileContextMenu}
                    onContainerContextMenu={canEditBoard ? onContainerContextMenu : undefined}
                    selectedContainerId={selectedSpaceId}
                    onTileMove={canEditBoard ? (id, position, spaceId) => { if (spaceId) void moveAgent(id, spaceId, position).catch(() => {}) } : undefined}
                    onContainerMove={canEditBoard ? moveBox : undefined}
                    onResizeContainerLocal={canEditBoard ? resizeBox : undefined}
                    onResizeContainerCommit={canEditBoard ? commitResize : undefined}
                    onResizingContainerChange={id => { if (!id || gridCurrent()) setResizing(id) }}
                    onContainerAdd={canEditBoard ? (sourceId, side) => openBoxDialog({ kind: 'create', sourceId, side }) : undefined}
                    containerAddPreview={canEditBoard ? (sourceId, side) => { const source = board!.spaces.find(space => space.id === sourceId); return source ? freeRectOnSide(source, side, board!.spaces) : null } : undefined}
                    containerAddLabel="Add a Box on this side"
                    paused={gridBlocked || menuInteracting}
                    locked={gridBlocked || !!placement?.saving}
                    placing={!!placement && !placement.position}
                    placingTile={placement ? { span: 2, style: agentTileStyle('idle', placement.name) } : undefined}
                    placementContainerId={templatePlacement?.spaceId ?? newCoworker?.spaceId ?? null}
                    onConfirmPlacement={placement && !placement.position && !gridBlocked ? placeCopy : undefined}
                    selectedTileId={selectedAgentId}
                    frameInset={{ left: panelInsetLeft, right: panelInsetRight }}
                    recenterSignal={recenterSignal}
                    focusRequest={focusRequest}
                    fitToContent
                    canDraw={false}
                    showViewControls={tiles.length > 0 || !!board?.spaces.length}
                    viewControlsPlacement="top-right"
                    viewControlsClassName={selectedAgentId ? 'md:top-auto md:right-auto md:bottom-16 md:left-4' : undefined}
                    onTileSelect={placement || gridBlocked ? undefined : id => {
                        if (board && !gridCurrent()) return
                        if (id) openCoworker(id)
                        else if (selectedAgentId && !board) onDismiss?.()
                    }}
                    onContainerSelect={gridBlocked || placement ? undefined : board ? id => {
                        if (!gridCurrent()) return
                        if (id === 'desktop-empty-box') { openBoxDialog({ kind: 'create' }); return }
                        setSelectedSpaceId(id)
                        if (id && board.spaces.some(space => space.id === id) && !board.placements.some(placed => placed.spaceId === id)) onCreate(id)
                    } : tiles.length ? undefined : id => { if (id) onCreate() }}
                />
            }</DesktopBoardMenu>
            <div className="absolute top-4 left-4 z-40 flex items-start gap-2">{workspaceMenu}</div>
            <div className="absolute bottom-4 left-4 z-40 flex max-w-[calc(100%-2rem)] flex-wrap items-end gap-2">
            {!placement && onOpenConversation && <DesktopActionsInbox agents={agents} onOpenConversation={onOpenConversation} visibleSessionId={visibleSessionId} />}
            <ChromeBar aria-label="Board actions" role="group">
                {placement ? <div className="flex min-w-0 items-center gap-2 pl-3">
                    <div className="min-w-0" role="status">
                        <Shimmer as="span" duration={1.6} className="block truncate text-sm font-medium">
                            {placement.saving ? `Placing ${placement.name}…` : `Tap a tile to place ${placement.name}`}
                        </Shimmer>
                        {templatePlacement && !templatePlacement.submitted && <p className="text-xs text-muted-foreground">{templatePlacement.positions.length + 1} of {templatePlacement.template.agents.length} coworkers{templatePlacement.spaceId ? ' · Keep this team in the same Box' : ' · Choose a Box on the board'}</p>}
                        {placement.error && <p className="text-xs text-destructive" role="alert">{placement.error}</p>}
                    </div>
                    {!suggestion && !placement.position && <p className="text-xs text-muted-foreground">No free spot. Cancel and add or resize a Box.</p>}
                    <ChromeButton ref={placeButton} label={placement.position && !placement.saving ? 'Retry' : newCoworker || templatePlacement ? 'Place coworker' : 'Place copy'} disabled={placement.saving || (!suggestion && !placement.position) || gridBlocked}
                        onClick={() => { const position = placement.position ?? suggestion; if (position) void placeCopy(position) }} />
                    {templatePlacement?.submitted ? <ChromeButton label="Review installation" disabled={placement.saving || gridBlocked} onClick={onReviewTemplate} />
                        : <ChromeButton label="Cancel" disabled={placement.saving || newCoworker?.submitted} onClick={cancelCopy} />}
                </div> : <>
                    {onOpenConversation && <><DesktopFindChat onSelect={onOpenConversation} /><ChromeDivider /></>}
                    <ChromeButton icon={Plus} label="Add coworker" disabled={baseBlocked || !!spaceDialog || covered || creationChecking || !!creationError} onClick={() => onCreate()} />
                    {board && onBoardCommand && <><ChromeDivider /><ChromeButton icon={Plus} label="Add Box" disabled={gridBlocked} onClick={() => openBoxDialog({ kind: 'create' })} /></>}
                </>}
            </ChromeBar>
            {!placement && creationChecking && <p className="rounded-xl border bg-background px-3 py-2 text-xs text-muted-foreground" role="status">Checking previous creation…</p>}
            {!placement && creationError && <div role="alert" className="flex max-w-sm items-center gap-2 rounded-xl border bg-background px-3 py-2 text-xs"><p>{creationError}</p><Button size="sm" variant="outline" disabled={creationChecking || gridBlocked} onClick={()=>void onRetryCreation?.()}>Retry creation check</Button></div>}
            </div>
            {!spaceDialog && (commandError || boardError) && <div role="alert" className="absolute bottom-20 left-4 z-40 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm shadow-sm">
                <p>{commandError || boardError}</p>{(onRetryBoard || retryCommand.current) && <Button variant="outline" size="sm" disabled={baseBlocked} onClick={() => void retryBoard()}>Retry</Button>}
                {!boardError && <Button variant="ghost" size="sm" onClick={() => setCommandError('')}>Dismiss</Button>}
            </div>}
            {spaceDialog && board && <DesktopSpaceDialogs key={JSON.stringify(spaceDialog)} target={spaceDialog} spaces={board.spaces}
                memberCount={spaceDialog.kind === 'create' ? 0 : board.placements.filter(placed => placed.spaceId === spaceDialog.spaceId).length}
                onCommand={command} disabled={boardDisabled || boardSaving || quitting} onClose={() => setSpaceDialog(null)} onRestoreFocus={restoreBoxFocus} />}
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
