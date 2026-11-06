// E3 round34 lane A: live computer panel + app launch controls. Presentation/controller only.
// The viewer (DesktopViewer via BrowserRunScreen / IsolatedScreenDialog), the takeover lease
// (screen-session / takeover-screen) and the runtime stay root-owned; this package never creates a
// second viewer or lease store. Original pin a6d63a4b: AgentChat.tsx L810-895, ChatScreen.tsx,
// DesktopNotch.tsx, chat-screen-use.ts, tools/builtin/computer.ts (computer_open_app).
import type { DesktopComputerLauncherAvailability, DesktopComputerLauncherState } from '../../../../../packages/contracts/src/desktop-computer-launchers'
import type { BrowserRunIdentity, CurrentRunCheck, PassiveViewerTransport, TrustedCurrentRun } from '../browser-run'

export type ComputerPanelApp = 'browser' | 'terminal' | 'files'
/** Original DesktopNotch order: Browser, Files, Terminal. */
export const COMPUTER_PANEL_APPS: readonly ComputerPanelApp[] = ['browser', 'files', 'terminal']
export const COMPUTER_PANEL_LABELS: Record<ComputerPanelApp, string> = { browser: 'Browser', files: 'Files', terminal: 'Terminal' }

/** Exact owner of one panel instance. generation = the screen target's session generation (32 hex). */
export type ComputerPanelOwner = BrowserRunIdentity & { workspaceId: string; generation: string }

/** Root's trusted projection for the selected conversation (never derived from messages/tool names). */
export type ComputerPanelProjection = {
    workspaceId: string
    current: TrustedCurrentRun | null
    /** Session generation of the coworker's isolated screen target; null when no guest is running. */
    generation: string | null
    coworker: { enabled: boolean; deleted: boolean }
    /** Pending takeover for this exact session (accepted takeover.ts view). */
    takeover: { takeoverId: string; reason: string; url: string; opened: boolean } | null
    /** Actual guest/runtime capability, read-only (never ensures/starts Docker). */
    runtime: ComputerRuntimeState
    grants: { computer: boolean; browser: boolean; terminalLaunch: boolean; filesLaunch: boolean }
    /** Guest capability flags from installed image status (Round32 E availability). */
    capability: { terminalInstalled: boolean; filesInstalled: boolean }
    /** Human currently driving via the existing lease (screen status `driving`). */
    humanDriving: boolean
}

export type ComputerRuntimeState =
    | { kind: 'running' }
    | { kind: 'docker-absent' }
    | { kind: 'image-missing' }
    | { kind: 'container-stopped' }
    | { kind: 'disconnected' }
    | { kind: 'unavailable'; reason: string }

export type ComputerLaunchAvailability = { app: ComputerPanelApp; label: string; state: DesktopComputerLauncherState; reason: string }

/** Distinct modes: the model working, a person watching read-only, a person driving under the exact lease. */
export type ComputerPanelMode = 'model' | 'watch' | 'drive'

export type ComputerLaunchOutcome = { status: 'opened' | 'focused' } | { status: 'refused' | 'interrupted' | 'app-missing' | 'timeout'; reason: string }

/** Injected real operations. Each has a concrete adapter in adapters.ts or a named missing authority. */
export type ComputerPanelPorts = {
    checkCurrentRun: CurrentRunCheck
    transport: PassiveViewerTransport
    /**
     * Opens root's existing IsolatedScreenDialog for this exact owner (drive mode only after the
     * person presses Take control there; the dialog acquires/releases the accepted lease).
     */
    openFullViewer: (owner: ComputerPanelOwner, intent: { app: 'browser' } | { takeoverId: string }) => Promise<void>
    /** Human Terminal/Files launch in the guest. Missing authority until root mounts H-A1. */
    launchApp: (owner: ComputerPanelOwner, app: 'terminal' | 'files', requestId: string, signal: AbortSignal) => Promise<ComputerLaunchOutcome>
    /** Read-only current-owner revalidation before any reconnect or launch. */
    revalidateOwner: (owner: ComputerPanelOwner, signal: AbortSignal) => Promise<boolean>
}

export class MissingComputerPanelAuthority extends Error {
    constructor(public readonly authority: 'H-A1 human launcher route' | 'H-A2 panel projection route') {
        super(`Missing root authority: ${authority}.`)
        this.name = 'MissingComputerPanelAuthority'
    }
}

export type { DesktopComputerLauncherAvailability }
