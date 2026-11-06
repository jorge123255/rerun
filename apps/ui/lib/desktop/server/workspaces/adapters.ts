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
import { MissingDesktopWorkspaceAuthority, type DesktopWorkspaceMainBridge, type DesktopWorkspaceServerPorts } from './ports'

const AUTHORITY = 'W1-A4'

function requireMain(ports: DesktopWorkspaceServerPorts): DesktopWorkspaceMainBridge {
    if (!ports.main) throw new MissingDesktopWorkspaceAuthority(AUTHORITY)
    return ports.main
}

/** Concrete bindings: all catalog/switch effects go through the main bridge when root mounts it. */
export function createDesktopWorkspaceAdapters(ports: DesktopWorkspaceServerPorts) {
    return {
        async list(): Promise<DesktopWorkspaceListResult> {
            return requireMain(ports).list()
        },
        async create(input: DesktopWorkspaceCreateInput): Promise<DesktopWorkspaceCreateResult> {
            return requireMain(ports).create(input)
        },
        async rename(input: DesktopWorkspaceRenameInput): Promise<DesktopWorkspaceRenameResult> {
            return requireMain(ports).rename(input)
        },
        async switchTo(input: DesktopWorkspaceSwitchInput): Promise<DesktopWorkspaceSwitchResult> {
            return requireMain(ports).switchTo(input)
        },
        async reconcile() {
            return requireMain(ports).reconcile()
        },
    }
}

/**
 * Test/helper bridge that calls the main-process module graph in-process.
 * Production desktop must use IPC (W1-A4); this binding is for authored regressions
 * and for root's optional same-process harness only.
 */
export async function createInProcessWorkspaceBridge(input: {
    dataRoot: string
    installId: string
    ports: Record<string, unknown>
}): Promise<DesktopWorkspaceMainBridge> {
    // Dynamic path keeps Next from bundling Electron main into the UI server graph.
    const mod = await import('../../../../../desktop/src/main/workspaces/index.mjs')
    const coordinator = mod.createWorkspaceCoordinator({
        dataRoot: input.dataRoot,
        installId: input.installId,
        ports: input.ports,
    })
    return {
        list: () => coordinator.list(),
        create: (value) => coordinator.create(value),
        rename: (value) => coordinator.rename(value),
        switchTo: (value) => coordinator.switchTo(value),
        reconcile: () => coordinator.reconcile(),
    }
}
