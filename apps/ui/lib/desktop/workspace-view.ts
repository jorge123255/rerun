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
