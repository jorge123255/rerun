import { sameRun } from '../browser-run'
import type { ComputerLaunchAvailability, ComputerPanelApp, ComputerPanelOwner, ComputerPanelProjection, ComputerRuntimeState } from './contract'
import { COMPUTER_PANEL_APPS, COMPUTER_PANEL_LABELS } from './contract'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const GENERATION = /^[a-f0-9]{32}$/

/** Conversation facts root already owns (tab, board selection, page visibility). */
export type ComputerPanelView = { agentId: string; sessionId: string; active: boolean; selected: boolean; visible: boolean }

export type ComputerPanelPresentation =
    | { show: false; reason: 'no-run' | 'no-screen' | 'mismatch' | 'inactive' | 'hidden' | 'coworker-gone' | 'dismissed' | 'runtime' | 'takeover-pending'; runtimeReason?: string }
    | { show: true; owner: ComputerPanelOwner; site: string | null; mode: 'model' | 'watch' | 'drive'; takeover: ComputerPanelProjection['takeover'] }

export const ownerKey = (o: ComputerPanelOwner) => [o.workspaceId, o.agentId, o.sessionId, o.runId, o.generation].join('\u0000')
export const sameOwner = (a: ComputerPanelOwner | null | undefined, b: ComputerPanelOwner | null | undefined) => !!a && !!b && sameRun(a, b) && a.workspaceId === b.workspaceId && a.generation === b.generation

export const RUNTIME_REASONS: Record<Exclude<ComputerRuntimeState['kind'], 'running' | 'unavailable'>, string> = {
    'docker-absent': 'Docker is not running on this Mac, so the isolated screen is not available.',
    'image-missing': 'The isolated screen image is not installed.',
    'container-stopped': 'The coworker’s screen is stopped.',
    disconnected: 'The screen went away',
}
export function runtimeReason(runtime: ComputerRuntimeState): string | null {
    if (runtime.kind === 'running') return null
    return runtime.kind === 'unavailable' ? runtime.reason : RUNTIME_REASONS[runtime.kind]
}

/** Owner exists only for the exact trusted current run with a live screen and a valid generation. */
export function ownerOf(p: ComputerPanelProjection | null): ComputerPanelOwner | null {
    const c = p?.current
    if (!p || !c || !c.liveScreen || !p.generation || !GENERATION.test(p.generation) || !ID.test(p.workspaceId)) return null
    return { workspaceId: p.workspaceId, agentId: c.agentId, sessionId: c.sessionId, runId: c.runId, generation: p.generation }
}

/**
 * Pure open rule, adapted from original AgentChat: screenShown = (showLoader && runOnScreen) || takeoverAsk.
 * Desktop replaces the message scan (runUsesScreen) with root's trusted liveScreen so a historical tool
 * part can never open a screen. Dismissal is per exact owner (+ takeover id), so duplicate events for
 * that owner never reopen it, while a new run/generation/takeover is a new decision.
 */
export function presentComputerPanel(p: ComputerPanelProjection | null, view: ComputerPanelView, dismissed: ReadonlySet<string>): ComputerPanelPresentation {
    if (!p?.current) return { show: false, reason: 'no-run' }
    if (p.current.agentId !== view.agentId || p.current.sessionId !== view.sessionId) return { show: false, reason: 'mismatch' }
    if (p.coworker.deleted || !p.coworker.enabled) return { show: false, reason: 'coworker-gone' }
    if (!view.active || !view.selected) return { show: false, reason: 'inactive' }
    if (!view.visible) return { show: false, reason: 'hidden' }
    // The accepted DesktopBrowserCard owns a pending takeover's screen and controls: never a second viewer.
    if (p.takeover) return { show: false, reason: 'takeover-pending' }
    const reason = runtimeReason(p.runtime)
    if (reason) return { show: false, reason: 'runtime', runtimeReason: reason }
    const owner = ownerOf(p)
    if (!owner) return { show: false, reason: 'no-screen' }
    if (dismissed.has(dismissKey(owner, p.takeover?.takeoverId ?? null))) return { show: false, reason: 'dismissed' }
    const mode = p.humanDriving ? 'drive' : 'model'
    return { show: true, owner, site: p.current.liveScreen?.site ?? null, mode, takeover: p.takeover }
}

export const dismissKey = (owner: ComputerPanelOwner, takeoverId: string | null) => `${ownerKey(owner)}\u0000${takeoverId ?? ''}`

/**
 * Launch availability per app. Browser uses the computer + browser grants (existing takeover path);
 * Terminal/Files use computer + their own Round32 launcher grants and real guest capability flags.
 * Order of reasons matches Round32 createLauncherAvailability.
 */
export function launchAvailability(p: ComputerPanelProjection | null, humanLaunchMounted: boolean): ComputerLaunchAvailability[] {
    return COMPUTER_PANEL_APPS.map(app => ({ app, label: COMPUTER_PANEL_LABELS[app], ...stateOf(app, p, humanLaunchMounted) }))
}
const READY = 'Open on this coworker’s isolated Linux screen.'
function stateOf(app: ComputerPanelApp, p: ComputerPanelProjection | null, mounted: boolean): Pick<ComputerLaunchAvailability, 'state' | 'reason'> {
    if (!p || !ownerOf(p)) return { state: 'refused', reason: 'There is no live screen for this run.' }
    if (p.coworker.deleted || !p.coworker.enabled) return { state: 'refused', reason: 'This coworker is disabled or deleted.' }
    const grant = app === 'browser' ? p.grants.browser : app === 'terminal' ? p.grants.terminalLaunch : p.grants.filesLaunch
    if (!p.grants.computer || !grant) return { state: 'permission-off', reason: app === 'browser' ? 'Enable computer control and the browser permission.' : 'Enable computer control and this app’s separate launcher permission.' }
    const rt = runtimeReason(p.runtime)
    if (rt) return { state: 'runtime-unavailable', reason: rt }
    if (app !== 'browser') {
        if (!mounted) return { state: 'refused', reason: 'Opening this app from the panel is not available yet on this Mac.' }
        if (p.humanDriving) return { state: 'busy', reason: 'The screen is busy or the user is driving it.' }
        if (!(app === 'terminal' ? p.capability.terminalInstalled : p.capability.filesInstalled)) return { state: 'app-missing', reason: 'This app is not installed in the isolated guest.' }
    }
    return { state: 'ready', reason: READY }
}
