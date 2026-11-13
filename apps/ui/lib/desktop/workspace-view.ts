// The two ways to show a workspace: the isometric board, or the Simple view (a list of coworkers
// beside the chat). Each person picks one, remembered on this Mac.
export type DesktopWorkspaceView = 'board' | 'simple'

export const DESKTOP_WORKSPACE_VIEW_STORAGE_KEY = 'rerun:workspace-view'
const lastOpenedKey = (workspaceId: number) => `rerun:simple-view-coworker:${workspaceId}`

export function parseDesktopWorkspaceView(value: string | null | undefined): DesktopWorkspaceView | null {
    return value === 'board' || value === 'simple' ? value : null
}

export function loadDesktopWorkspaceView(): DesktopWorkspaceView | null {
    try { return parseDesktopWorkspaceView(localStorage.getItem(DESKTOP_WORKSPACE_VIEW_STORAGE_KEY)) } catch { return null }
}

export function rememberDesktopWorkspaceView(view: DesktopWorkspaceView): void {
    try { localStorage.setItem(DESKTOP_WORKSPACE_VIEW_STORAGE_KEY, view) } catch {}
}

// The frame on screen. Anything that needs the grid wins over the preference, which comes back on
// its own once the grid is no longer needed.
export function resolveDesktopWorkspaceView(context: { preference: DesktopWorkspaceView | null; placing: boolean }): DesktopWorkspaceView {
    return context.placing ? 'board' : context.preference ?? 'board'
}

export function readDesktopSimpleLastOpened(workspaceId: number): string | null {
    try { return localStorage.getItem(lastOpenedKey(workspaceId)) } catch { return null }
}

export function rememberDesktopSimpleLastOpened(workspaceId: number, agentId: string): void {
    try { localStorage.setItem(lastOpenedKey(workspaceId), agentId) } catch {}
}

// What the Simple view opens when nothing is open yet: the coworker open last on this Mac while it
// still exists, else the most recently active one.
export function desktopSimpleInitialOpen({ remembered, agentIds, mostRecent }: { remembered: string | null; agentIds: readonly string[]; mostRecent: string | null }): string | null {
    if (remembered && agentIds.includes(remembered)) return remembered
    return mostRecent && agentIds.includes(mostRecent) ? mostRecent : null
}
