// Concrete adapters over ACCEPTED operations, plus explicitly named missing authorities.
import { createScreenClientPassiveTransport, parseTrustedCurrentRun, sameRun, type CurrentRunCheck, type PassiveViewerTransport } from '../browser-run'
import { fetchDesktopScreenStatus, requestDesktopScreenTicket, type DesktopScreenStatusView } from '../screen-client'
import type { ComputerLaunchOutcome, ComputerPanelOwner, ComputerPanelPorts, ComputerPanelProjection, ComputerRuntimeState } from './contract'
import { MissingComputerPanelAuthority } from './contract'

const browserRunEndpoint = (agentId: string, sessionId: string) => `/api/desktop/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/browser-run`

/** Accepted route used by DesktopBrowserRun: GET trusted current run. */
export async function readTrustedCurrentRun(agentId: string, sessionId: string, signal: AbortSignal) {
    const response = await fetch(browserRunEndpoint(agentId, sessionId), { cache: 'no-store', signal })
    if (!response.ok) throw new Error('Could not check this run')
    return parseTrustedCurrentRun((await response.json()).trusted)
}

/** Same accepted check DesktopBrowserRun uses; never starts or ensures a runtime. */
export const httpCurrentRunCheck: CurrentRunCheck = async (run, signal) => {
    const current = await readTrustedCurrentRun(run.agentId, run.sessionId, signal)
    return sameRun(current, run) && current?.liveScreen ? { current: true, screen: 'running', site: current.liveScreen.site } : { current: false }
}

/** Accepted watch-only ticket (requireRunning: true refuses a stopped guest; no lease, no input). */
export const screenClientWatchTransport: PassiveViewerTransport = createScreenClientPassiveTransport(requestDesktopScreenTicket)

/** Maps the accepted screen status view to the panel runtime state, without guessing. */
export function runtimeFromStatus(status: DesktopScreenStatusView): ComputerRuntimeState {
    switch (status.state) {
        case 'available': case 'taken-over': return status.running === false ? { kind: 'container-stopped' } : { kind: 'running' }
        case 'starting': return { kind: 'unavailable', reason: 'The screen is starting.' }
        case 'disconnected': return { kind: 'disconnected' }
        default: {
            const reason = status.reason ?? 'The screen is not available'
            if (/docker/i.test(reason) && /(not running|absent|unavailable|missing)/i.test(reason)) return { kind: 'docker-absent' }
            if (/image/i.test(reason)) return { kind: 'image-missing' }
            return { kind: 'unavailable', reason }
        }
    }
}

/** Facts no accepted UI route exposes yet: H-A2 (generation, grants, launcher capability, coworker lifecycle, takeover). */
export type ComputerPanelRootFacts = Pick<ComputerPanelProjection, 'workspaceId' | 'generation' | 'coworker' | 'takeover' | 'grants' | 'capability'>
export type ReadComputerPanelRootFacts = (agentId: string, sessionId: string, signal: AbortSignal) => Promise<ComputerPanelRootFacts>
export const missingRootFacts: ReadComputerPanelRootFacts = async () => { throw new MissingComputerPanelAuthority('H-A2 panel projection route') }

/** Projection composed from accepted routes + root facts. Any failure → null (panel falls back to loader). */
export function createComputerPanelProjectionReader(readFacts: ReadComputerPanelRootFacts = missingRootFacts) {
    return async (agentId: string, sessionId: string, signal: AbortSignal): Promise<ComputerPanelProjection | null> => {
        const [current, status, facts] = await Promise.all([readTrustedCurrentRun(agentId, sessionId, signal), fetchDesktopScreenStatus(agentId, signal), readFacts(agentId, sessionId, signal)])
        signal.throwIfAborted()
        return { ...facts, current, runtime: runtimeFromStatus(status), humanDriving: status.driving }
    }
}

/**
 * Human Terminal/Files launch. Round32 E only exposes the model tool path (LauncherPorts keyed by a
 * tool invocation). Root must mount H-A1: POST /api/desktop/agents/:agentId/sessions/:sessionId/computer-launcher
 * {requestId, runId, generation, app} → DesktopComputerLauncherOutcome, reusing the same attempt store,
 * authority and withControl. Until then this adapter refuses honestly.
 */
export const missingHumanLauncher: ComputerPanelPorts['launchApp'] = async () => { throw new MissingComputerPanelAuthority('H-A1 human launcher route') }

/** Ready-to-use H-A1 client once root mounts the route. */
export function createHttpHumanLauncher(fetcher: typeof fetch = fetch): ComputerPanelPorts['launchApp'] {
    return async (owner, app, requestId, signal): Promise<ComputerLaunchOutcome> => {
        const response = await fetcher(`/api/desktop/agents/${encodeURIComponent(owner.agentId)}/sessions/${encodeURIComponent(owner.sessionId)}/computer-launcher`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal,
            body: JSON.stringify({ requestId, runId: owner.runId, generation: owner.generation, app }),
        })
        if (response.status === 404) throw new MissingComputerPanelAuthority('H-A1 human launcher route')
        const body = (await response.json().catch(() => null)) as { status?: string; acknowledged?: boolean; error?: string } | null
        if (!response.ok) return { status: 'refused', reason: typeof body?.error === 'string' ? body.error.slice(0, 200) : 'This launcher request is unavailable.' }
        if ((body?.status === 'opened' || body?.status === 'focused') && body.acknowledged === true) return { status: body.status }
        if (body?.status === 'app-missing') return { status: 'app-missing', reason: 'This app is not installed in the isolated guest.' }
        if (body?.status === 'timeout') return { status: 'timeout', reason: 'The app did not become visible before the deadline.' }
        return { status: 'interrupted', reason: 'The launcher attempt was interrupted; it was not replayed.' }
    }
}

/** Revalidation over the accepted trusted current-run route plus the exact generation from root facts. */
export function createOwnerRevalidation(readFacts: ReadComputerPanelRootFacts = missingRootFacts): ComputerPanelPorts['revalidateOwner'] {
    return async (owner: ComputerPanelOwner, signal) => {
        const [current, facts] = await Promise.all([readTrustedCurrentRun(owner.agentId, owner.sessionId, signal), readFacts(owner.agentId, owner.sessionId, signal)])
        return !!current?.liveScreen && sameRun(current, owner) && facts.workspaceId === owner.workspaceId && facts.generation === owner.generation && facts.coworker.enabled && !facts.coworker.deleted
    }
}
