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

// The Simple view's list (upstream #279): one section per Box under the Chief of Staff, an empty Box
// kept so a coworker can be moved into it. The Boxes folded away are kept with the workspace on
// this Mac, where upstream keeps them in the browser: the app's address changes with every launch.
export const desktopSidebarListSchema = z.strictObject({ collapsed: z.array(z.uuid()).max(500) })
export type DesktopSidebarList = z.infer<typeof desktopSidebarListSchema>
export const emptyDesktopSidebarList = (): DesktopSidebarList => ({ collapsed: [] })

export const desktopSidebarListChangeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('collapsed'), ids: z.array(z.uuid()).max(500) }),
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
    return { ...list, collapsed: [...new Set(change.ids)] }
}

export type DesktopSidebarSection<A, B> = { box: B; members: A[] }

// One section per Box in the order the Boxes were made (the board's own order), their coworkers in
// the order they were made. A coworker the board has in no listed Box is never dropped: it follows
// the sections in `loose`.
export function desktopSidebarSections<A extends { id: string; name: string; createdAt?: string }, B extends { id: string }>(agents: readonly A[], boxes: readonly B[], boxOf: (agentId: string) => string | null): { sections: DesktopSidebarSection<A, B>[]; loose: A[] } {
    const made = [...agents].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.name.localeCompare(b.name))
    const known = new Set(boxes.map(box => box.id))
    const home = new Map(made.map(agent => [agent.id, boxOf(agent.id)]))
    return {
        sections: boxes.map(box => ({ box, members: made.filter(agent => home.get(agent.id) === box.id) })),
        loose: made.filter(agent => { const box = home.get(agent.id); return !box || !known.has(box) }),
    }
}
