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
