export type DesktopControlContext = {
    open: boolean; disabled: boolean; scope: string; runtimeWorkspaceId?: number; runtimeLaunchNonce?: string; board?: { revision: number }
}
export function controlContextKey(context: DesktopControlContext) {
    return JSON.stringify([context.runtimeWorkspaceId ?? null, context.runtimeLaunchNonce ?? null, context.scope, context.board?.revision ?? null])
}
export function controlContextAvailable(captured: DesktopControlContext, current: DesktopControlContext, quitting: boolean) {
    return !quitting && captured.open && !captured.disabled && current.open && !current.disabled && Number.isSafeInteger(current.runtimeWorkspaceId)
        && (current.runtimeWorkspaceId ?? 0) > 0 && controlContextKey(captured) === controlContextKey(current)
}

