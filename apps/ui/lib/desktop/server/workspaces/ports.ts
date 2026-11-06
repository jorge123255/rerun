import 'server-only'
import type {
    DesktopWorkspaceCreateInput,
    DesktopWorkspaceCreateResult,
    DesktopWorkspaceListResult,
    DesktopWorkspaceRenameInput,
    DesktopWorkspaceRenameResult,
    DesktopWorkspaceSwitchInput,
    DesktopWorkspaceSwitchResult,
} from '@rerun/contracts'

/** Server-facing ports. Main-process coordinator is the effect authority for switches. */
export type DesktopWorkspaceMainBridge = {
    list: () => Promise<DesktopWorkspaceListResult>
    create: (input: DesktopWorkspaceCreateInput) => Promise<DesktopWorkspaceCreateResult>
    rename: (input: DesktopWorkspaceRenameInput) => Promise<DesktopWorkspaceRenameResult>
    switchTo: (input: DesktopWorkspaceSwitchInput) => Promise<DesktopWorkspaceSwitchResult>
    reconcile: () => Promise<DesktopWorkspaceListResult & { requiresManualRecovery: boolean }>
}

export type DesktopWorkspaceServerPorts = {
    /** IPC/main bridge. Missing until root mounts W1-A4. */
    main: DesktopWorkspaceMainBridge | null
}

export class MissingDesktopWorkspaceAuthority extends Error {
    constructor(public readonly authority: string) {
        super(`Missing root authority: ${authority}`)
        this.name = 'MissingDesktopWorkspaceAuthority'
    }
}
