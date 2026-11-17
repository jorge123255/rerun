import { z } from 'zod'

// The two ways to show a workspace: the isometric board, or the Simple view (a list of coworkers
// beside the chat). The choice is kept with the workspace on this Mac.
export const desktopWorkspaceViewSchema = z.enum(['board', 'simple'])
export type DesktopWorkspaceView = z.infer<typeof desktopWorkspaceViewSchema>

export const desktopWorkspaceViewStateSchema = z.strictObject({ view: desktopWorkspaceViewSchema.nullable(), lastOpened: z.uuid().nullable() })
export type DesktopWorkspaceViewState = z.infer<typeof desktopWorkspaceViewStateSchema>

export const desktopWorkspaceViewChangeSchema = z.union([
    z.strictObject({ view: desktopWorkspaceViewSchema, lastOpened: z.undefined().optional() }),
    z.strictObject({ lastOpened: z.uuid(), view: z.undefined().optional() }),
])
export type DesktopWorkspaceViewChange = z.infer<typeof desktopWorkspaceViewChangeSchema>

const PATH = '/api/desktop/workspace-view'

export async function loadDesktopWorkspaceView(signal?: AbortSignal): Promise<DesktopWorkspaceViewState | null> {
    try {
        const response = await fetch(PATH, { cache: 'no-store', signal })
        return response.ok ? desktopWorkspaceViewStateSchema.parse(await response.json()) : null
    } catch { return null }
}

// Best-effort: a preference that could not be saved still applies until the app closes.
export function saveDesktopWorkspaceView(change: DesktopWorkspaceViewChange): void {
    void fetch(PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) }).catch(() => {})
}

// The frame on screen. Anything that needs the grid wins over the preference, which comes back on
// its own once the grid is no longer needed.
export function resolveDesktopWorkspaceView(context: { preference: DesktopWorkspaceView | null; placing: boolean }): DesktopWorkspaceView {
    return context.placing ? 'board' : context.preference ?? 'board'
}

// What the Simple view opens when nothing is open yet: the coworker open last while it still
// exists, else the most recently active one.
export function desktopSimpleInitialOpen({ remembered, agentIds, mostRecent }: { remembered: string | null; agentIds: readonly string[]; mostRecent: string | null }): string | null {
    if (remembered && agentIds.includes(remembered)) return remembered
    return mostRecent && agentIds.includes(mostRecent) ? mostRecent : null
}

// The Simple view's list (upstream #279-#281): one section per Box under the Chief of Staff, an empty
// Box kept so a coworker can be moved into it. The Boxes folded away and the order someone dragged
// the list into are kept with the workspace on this Mac, where upstream keeps the first in the
// browser and the second in two Supabase columns: the app's address changes with every launch, and
// there is no Supabase. A rank is absent until someone arranges the list. A coworker's rank names
// the Box it was given in: in another Box it means nothing, and the coworker joins that Box's end.
const rankSchema = z.number().finite()
export const desktopSidebarListSchema = z.strictObject({
    collapsed: z.array(z.uuid()).max(500),
    boxes: z.record(z.string(), rankSchema),
    agents: z.record(z.string(), z.strictObject({ box: z.string(), rank: rankSchema })),
})
export type DesktopSidebarList = z.infer<typeof desktopSidebarListSchema>
export const emptyDesktopSidebarList = (): DesktopSidebarList => ({ collapsed: [], boxes: {}, agents: {} })

const orderWriteSchema = z.strictObject({ id: z.uuid(), order: rankSchema })
export type DesktopSidebarOrderWrite = z.infer<typeof orderWriteSchema>
export const desktopSidebarListChangeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('collapsed'), ids: z.array(z.uuid()).max(500) }),
    // Where Boxes sit in the list, and where coworkers sit in one Box.
    z.strictObject({ kind: z.literal('boxes'), writes: z.array(orderWriteSchema).min(1).max(500) }),
    z.strictObject({ kind: z.literal('agents'), boxId: z.uuid(), writes: z.array(orderWriteSchema).min(1).max(500) }),
    // What no longer means anything: a Box or a coworker that is gone, a coworker's rank in a Box it left.
    z.strictObject({ kind: z.literal('forget'), boxes: z.array(z.uuid()).max(500), agents: z.array(z.uuid()).max(500) }),
])
export type DesktopSidebarListChange = z.infer<typeof desktopSidebarListChangeSchema>

const LIST_PATH = '/api/desktop/workspace-view/list'

export async function loadDesktopSidebarList(signal?: AbortSignal): Promise<DesktopSidebarList | null> {
    try {
        const response = await fetch(LIST_PATH, { cache: 'no-store', signal })
        return response.ok ? desktopSidebarListSchema.parse(await response.json()) : null
    } catch { return null }
}

// Null when it could not be saved: the caller reads the list again rather than show what is not kept.
export async function saveDesktopSidebarList(change: DesktopSidebarListChange): Promise<DesktopSidebarList | null> {
    try {
        const response = await fetch(LIST_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
        return response.ok ? desktopSidebarListSchema.parse(await response.json()) : null
    } catch { return null }
}

// What a change makes of the list, here before the answer comes back and in the database alike.
export function applyDesktopSidebarListChange(list: DesktopSidebarList, change: DesktopSidebarListChange): DesktopSidebarList {
    if (change.kind === 'collapsed') return { ...list, collapsed: [...new Set(change.ids)] }
    if (change.kind === 'boxes') return { ...list, boxes: { ...list.boxes, ...Object.fromEntries(change.writes.map(write => [write.id, write.order])) } }
    if (change.kind === 'agents') return { ...list, agents: { ...list.agents, ...Object.fromEntries(change.writes.map(write => [write.id, { box: change.boxId, rank: write.order }])) } }
    const boxes = new Set(change.boxes), agents = new Set(change.agents)
    return {
        collapsed: list.collapsed.filter(id => !boxes.has(id)),
        boxes: Object.fromEntries(Object.entries(list.boxes).filter(([id]) => !boxes.has(id))),
        agents: Object.fromEntries(Object.entries(list.agents).filter(([id]) => !agents.has(id))),
    }
}

export type DesktopSidebarSection<A, B> = { box: B; members: A[] }
type Rank = { order: number | undefined; made: string }

// Where an item sits in the list: the order someone arranged before the items nobody placed yet,
// which follow in the order they were made (upstream's bySidebarOrder).
function bySidebarOrder(a: Rank, b: Rank): number {
    const placedA = typeof a.order === 'number', placedB = typeof b.order === 'number'
    if (placedA && placedB) return (a.order as number) - (b.order as number) || a.made.localeCompare(b.made)
    if (placedA !== placedB) return placedA ? -1 : 1
    return a.made.localeCompare(b.made)
}

/** The rank a coworker holds in the Box it is in now; none if it was ranked in another Box. */
export function desktopAgentRank(list: Pick<DesktopSidebarList, 'agents'> | undefined, agentId: string, boxId: string | null): number | undefined {
    const saved = list?.agents[agentId]
    return saved && saved.box === boxId ? saved.rank : undefined
}

// One section per Box, its coworkers inside. With nothing arranged the Boxes follow the order they
// were made (the board's own order) and their coworkers the order they were made. A coworker the
// board has in no listed Box is never dropped: it follows the sections in `loose`.
export function desktopSidebarSections<A extends { id: string; name: string; createdAt?: string }, B extends { id: string }>(agents: readonly A[], boxes: readonly B[], boxOf: (agentId: string) => string | null, list?: Pick<DesktopSidebarList, 'boxes' | 'agents'>): { sections: DesktopSidebarSection<A, B>[]; loose: A[] } {
    const home = new Map(agents.map(agent => [agent.id, boxOf(agent.id)]))
    const agentRank = (agent: A): Rank => ({ order: desktopAgentRank(list, agent.id, home.get(agent.id) ?? null), made: `${agent.createdAt ?? ''}\u0000${agent.name}\u0000${agent.id}` })
    const ordered = [...agents].sort((a, b) => bySidebarOrder(agentRank(a), agentRank(b)))
    const known = new Set(boxes.map(box => box.id))
    const boxRank = (box: B, index: number): Rank => ({ order: list?.boxes[box.id], made: String(index).padStart(6, '0') })
    return {
        sections: boxes.map((box, index) => ({ box, rank: boxRank(box, index) })).sort((a, b) => bySidebarOrder(a.rank, b.rank))
            .map(({ box }) => ({ box, members: ordered.filter(agent => home.get(agent.id) === box.id) })),
        loose: ordered.filter(agent => { const box = home.get(agent.id); return !box || !known.has(box) }),
    }
}

// What to write so `movedId` lands at `index` of `list`, the list as shown without it. One write
// between two placed neighbours; the whole list numbered again the first time, while some of it was
// never placed, or once the gap between two neighbours runs out (upstream's sidebarOrderWrites).
export function desktopSidebarOrderWrites(list: readonly { id: string; order: number | null | undefined }[], movedId: string, index: number): DesktopSidebarOrderWrite[] {
    const before = list[index - 1]?.order
    const after = list[index]?.order
    const hasBefore = index > 0
    const hasAfter = index < list.length
    if (!hasBefore && !hasAfter) return [{ id: movedId, order: 1 }]
    if (hasBefore && hasAfter && typeof before === 'number' && typeof after === 'number' && after - before > 1e-6) return [{ id: movedId, order: (before + after) / 2 }]
    if (hasBefore && !hasAfter && typeof before === 'number') return [{ id: movedId, order: before + 1 }]
    if (!hasBefore && hasAfter && typeof after === 'number') return [{ id: movedId, order: after - 1 }]
    const ids = list.map(item => item.id)
    ids.splice(index, 0, movedId)
    const current = new Map(list.map(item => [item.id, item.order]))
    return ids.map((id, position) => ({ id, order: position + 1 })).filter(write => write.id === movedId || current.get(write.id) !== write.order)
}

// What the saved list still says about things that are gone: a Box or a coworker deleted, a
// coworker's rank in a Box it has left. `arriving` names the Box a dragged coworker is on its way
// to: its rank there is kept until the board has moved it. A coworker the board has in no Box
// keeps its rank, in case it is only missing for a moment.
export function desktopSidebarStale(list: DesktopSidebarList, boxIds: readonly string[], homes: Readonly<Record<string, string | null>>, arriving: ReadonlyMap<string, string> = new Map()): { boxes: string[]; agents: string[] } {
    const boxes = new Set(boxIds)
    return {
        boxes: [...new Set([...Object.keys(list.boxes), ...list.collapsed])].filter(id => !boxes.has(id)),
        agents: Object.entries(list.agents).filter(([id, saved]) => {
            if (!(id in homes)) return true
            const home = homes[id]
            return !!home && home !== saved.box && arriving.get(id) !== saved.box
        }).map(([id]) => id),
    }
}

// Dragging the list (upstream #281, #283). One id space for the drag: a Box by its header, a
// coworker by its tile, a Box again as the place a coworker is dropped into (its whole section,
// folded or empty included).
export const desktopSidebarDragId = {
    box: (id: string) => `box:${id}`,
    agent: (id: string) => `agent:${id}`,
    drop: (id: string) => `drop:${id}`,
    idOf: (dragId: string | number) => String(dragId).slice(String(dragId).indexOf(':') + 1),
    kindOf: (dragId: string | number) => String(dragId).slice(0, String(dragId).indexOf(':')),
}

export type DesktopSidebarDrop =
    | { kind: 'boxes'; writes: DesktopSidebarOrderWrite[] }
    | { kind: 'agents'; boxId: string; writes: DesktopSidebarOrderWrite[] }
    // Into another Box: the ranks of that Box, the dragged coworker's among them, and the move itself.
    | { kind: 'move'; agentId: string; boxId: string; writes: DesktopSidebarOrderWrite[] }

function moved<T>(items: readonly T[], from: number, to: number): T[] {
    const next = [...items]
    next.splice(to, 0, ...next.splice(from, 1))
    return next
}

// What a drop asks for, or null when it changes nothing. A Box takes its place among the others. A
// coworker takes the place of the coworker it is dropped on, in its Box or another; dropped on
// another Box (its name, an empty or folded one) it joins that Box's end; dropped on the name of
// its own Box or between two tiles it stays where it was.
export function desktopSidebarDrop(sections: readonly DesktopSidebarSection<{ id: string }, { id: string }>[], list: Pick<DesktopSidebarList, 'boxes' | 'agents'> | undefined, activeId: string, overId: string | null): DesktopSidebarDrop | null {
    if (!overId) return null
    const { idOf, kindOf } = desktopSidebarDragId
    if (kindOf(activeId) === 'box') {
        const boxes = sections.map(section => section.box)
        const from = boxes.findIndex(box => box.id === idOf(activeId))
        const to = boxes.findIndex(box => box.id === idOf(overId))
        if (from < 0 || to < 0 || from === to) return null
        const others = moved(boxes, from, to).filter(box => box.id !== idOf(activeId)).map(box => ({ id: box.id, order: list?.boxes[box.id] }))
        return { kind: 'boxes', writes: desktopSidebarOrderWrites(others, idOf(activeId), to) }
    }
    const agentId = idOf(activeId)
    const overAgent = kindOf(overId) === 'agent'
    const source = sections.find(section => section.members.some(member => member.id === agentId))
    const target = overAgent ? sections.find(section => section.members.some(member => member.id === idOf(overId))) : sections.find(section => section.box.id === idOf(overId))
    if (!source || !target) return null
    const overIndex = overAgent ? target.members.findIndex(member => member.id === idOf(overId)) : target.members.length
    const rank = (member: { id: string }) => ({ id: member.id, order: desktopAgentRank(list, member.id, target.box.id) })
    if (source.box.id === target.box.id) {
        if (!overAgent) return null
        const from = source.members.findIndex(member => member.id === agentId)
        if (from === overIndex) return null
        return { kind: 'agents', boxId: source.box.id, writes: desktopSidebarOrderWrites(moved(source.members, from, overIndex).filter(member => member.id !== agentId).map(rank), agentId, overIndex) }
    }
    return { kind: 'move', agentId, boxId: target.box.id, writes: desktopSidebarOrderWrites(target.members.map(rank), agentId, overIndex) }
}
