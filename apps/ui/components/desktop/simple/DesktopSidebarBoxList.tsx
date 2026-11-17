'use client'

import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { ChevronDown } from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { desktopSidebarDragId, desktopSidebarDrop, type DesktopSidebarDrop, type DesktopSidebarList, type DesktopSidebarSection } from '@/lib/desktop/workspace-view'
import { cn } from '@/lib/utils'
import { DesktopSidebarBoxSection, type DesktopBoxDialogKind } from './DesktopSidebarBoxSection'

const { box: boxId, agent: agentId, drop: dropId, idOf, kindOf } = desktopSidebarDragId

// A Box only lands among Boxes. A coworker lands before the coworker under the pointer, or at the
// end of the Box whose section the pointer is in.
const collision: CollisionDetection = args => {
    const draggingBox = kindOf(args.active.id) === 'box'
    const droppableContainers = args.droppableContainers.filter(container => (kindOf(container.id) === 'box') === draggingBox)
    const scoped = { ...args, droppableContainers }
    if (draggingBox) return closestCenter(scoped)
    const under = pointerWithin(scoped)
    const tiles = under.filter(hit => kindOf(hit.id) === 'agent')
    if (tiles.length > 0) return tiles
    return under.length > 0 ? under : closestCenter(scoped)
}

// The keyboard picks an item up only from the item itself: Enter on the coworker's button inside
// still opens it, and Enter on a Box's name still folds it.
class OwnKeyboardSensor extends KeyboardSensor {
    static activators = KeyboardSensor.activators.map(activator => ({
        ...activator,
        handler: (event: KeyboardEvent, ...rest: Parameters<typeof activator.handler> extends [unknown, ...infer Rest] ? Rest : never) => event.target === event.currentTarget && activator.handler(event, ...rest),
    }))
}

type Agent = { id: string; name: string; enabled?: boolean }
type Box = { id: string; name: string | null }

/**
 * The Simple view's Boxes and their coworkers, in the order the workspace arranged them by dragging
 * (upstream #281, with the review fixes of #283). A Box dragged by its name takes its place among
 * the others; a coworker dragged takes its place in its Box or lands in another one, folded or empty
 * included. On this Mac one person owns the workspace, so upstream's "who manages the Box" gate
 * becomes: nothing is picked up while the list is disabled or where the handler is left out.
 */
export function DesktopSidebarBoxList<A extends Agent>({ sections, order, collapsed, waitingIn, disabled = false, onToggle, onDialog, renderTile, onDrop, canMoveBetweenBoxes = false }: {
    sections: readonly DesktopSidebarSection<A, Box>[]
    order?: Pick<DesktopSidebarList, 'boxes' | 'agents'>
    collapsed: readonly string[]
    waitingIn: (members: readonly A[]) => boolean
    disabled?: boolean
    onToggle: (boxId: string) => void
    onDialog?: (kind: DesktopBoxDialogKind, boxId: string) => void
    renderTile: (agent: A) => ReactNode
    // Left out, nothing can be picked up and the list only reads.
    onDrop?: (drop: DesktopSidebarDrop) => void
    // A move to another Box goes through the board: without it a coworker only moves inside its Box.
    canMoveBetweenBoxes?: boolean
}) {
    const [active, setActive] = useState<string | null>(null)
    const [overId, setOverId] = useState<string | null>(null)
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(OwnKeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
    const draggable = !!onDrop && !disabled

    const onDragStart = ({ active: started }: DragStartEvent) => setActive(String(started.id))
    const onDragOver = ({ over }: DragOverEvent) => setOverId(over ? String(over.id) : null)
    const endDrag = () => { setActive(null); setOverId(null) }
    const onDragEnd = ({ active: dropped, over }: DragEndEvent) => {
        endDrag()
        if (!draggable) return
        const drop = desktopSidebarDrop(sections, order, String(dropped.id), over ? String(over.id) : null)
        if (drop && (drop.kind !== 'move' || canMoveBetweenBoxes)) onDrop(drop)
    }

    const activeKind = active ? kindOf(active) : null
    const homeOf = (id: string) => sections.find(section => section.members.some(member => member.id === id))
    const activeAgent = activeKind === 'agent' ? homeOf(idOf(active as string))?.members.find(member => member.id === idOf(active as string)) : undefined
    const activeBox = activeKind === 'box' ? sections.find(section => section.box.id === idOf(active as string)) : undefined
    // Where a coworker dragged out of its Box would land: that Box lights up, and the tile it would
    // sit before shows a line, since dnd-kit only makes room inside the list the drag started in.
    const overBoxId = !overId ? null : kindOf(overId) === 'agent' ? homeOf(idOf(overId))?.box.id : idOf(overId)
    const landingBoxId = canMoveBetweenBoxes && activeAgent && overBoxId && overBoxId !== homeOf(activeAgent.id)?.box.id ? overBoxId : null
    const landingBeforeId = landingBoxId && overId && kindOf(overId) === 'agent' ? idOf(overId) : null

    return <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={endDrag}>
        <SortableContext items={sections.map(section => boxId(section.box.id))} strategy={verticalListSortingStrategy}>
            {sections.map(section => <SortableBox key={section.box.id} section={section} draggable={draggable} disabled={disabled}
                collapsed={collapsed.includes(section.box.id)} waiting={waitingIn(section.members)} landing={landingBoxId === section.box.id}
                onToggle={() => onToggle(section.box.id)} onDialog={onDialog && (kind => onDialog(kind, section.box.id))}
                renderTile={agent => <SortableTile key={agent.id} id={agent.id} draggable={draggable} landingBefore={landingBeforeId === agent.id}>{renderTile(agent)}</SortableTile>} />)}
        </SortableContext>
        <DragOverlay>
            {activeAgent && <div data-simple-drag-ghost="agent" className="flex w-68 cursor-grabbing items-center gap-2.5 rounded-lg border border-border bg-background py-2 pr-3 pl-2 shadow-lg">
                <AgentBuddy agentId={activeAgent.id} mood={activeAgent.enabled === false ? 'asleep' : 'idle'} size={32} facing="right" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{activeAgent.name}</span>
            </div>}
            {activeBox && <div data-simple-drag-ghost="box" className="flex h-8 w-68 cursor-grabbing items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground shadow-lg">
                <ChevronDown className="size-3 shrink-0" />
                <span className="truncate">{activeBox.box.name?.trim() || 'Box'}</span>
                <span className="shrink-0 text-muted-foreground/60 tabular-nums">{activeBox.members.length}</span>
            </div>}
        </DragOverlay>
    </DndContext>
}

function SortableBox<A extends Agent>({ section, draggable, disabled, collapsed, waiting, landing, onToggle, onDialog, renderTile }: {
    section: DesktopSidebarSection<A, Box>
    draggable: boolean
    disabled: boolean
    collapsed: boolean
    waiting: boolean
    landing: boolean
    onToggle: () => void
    onDialog?: (kind: DesktopBoxDialogKind) => void
    renderTile: (agent: A) => ReactNode
}) {
    const { box, members } = section
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: boxId(box.id), disabled: !draggable, attributes: { role: 'group' } })
    const { setNodeRef: setDropRef } = useDroppable({ id: dropId(box.id) })
    const ref = (node: HTMLElement | null) => { setNodeRef(node); setDropRef(node) }
    return <SortableContext items={members.map(member => agentId(member.id))} strategy={verticalListSortingStrategy}>
        <DesktopSidebarBoxSection box={box} members={members} collapsed={collapsed} waiting={waiting} disabled={disabled} onToggle={onToggle} onDialog={onDialog} renderTile={renderTile}
            drag={{ ref, style: { transform: CSS.Translate.toString(transform), transition }, handle: draggable ? { ...attributes, ...listeners } : {}, dragging: isDragging, target: landing }} />
    </SortableContext>
}

function SortableTile({ id, draggable, landingBefore, children }: { id: string; draggable: boolean; landingBefore: boolean; children: ReactNode }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: agentId(id), disabled: !draggable, attributes: { role: 'group' } })
    return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} {...(draggable ? { ...attributes, ...listeners } : {})} data-simple-sortable-tile={id}
        className={cn('relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50', isDragging && 'opacity-40')}>
        {landingBefore && <span aria-hidden data-simple-landing-line className="pointer-events-none absolute inset-x-2 -top-0.5 z-10 h-0.5 rounded-full bg-brand" />}
        {children}
    </div>
}
