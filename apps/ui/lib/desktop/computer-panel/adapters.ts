// Concrete adapters over ACCEPTED operations, plus explicitly named missing authorities.
import { parseTrustedCurrentRun, sameRun, type CurrentRunCheck, type PassiveViewerTransport } from '../browser-run'
import { fetchDesktopScreenStatus, type DesktopScreenStatusView } from '../screen-client'
import type { ComputerLaunchOutcome, ComputerPanelOwner, ComputerPanelPorts, ComputerPanelProjection, ComputerRuntimeState } from './contract'
import { MissingComputerPanelAuthority, computerPanelProjectionSchema, computerPanelOutcomeSchema } from './contract'
import { readDesktopToolInstallBody } from '../tool-install-client'

const browserRunEndpoint = (agentId: string, sessionId: string) => `/api/desktop/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/browser-run`

/** Accepted route used by DesktopBrowserRun: GET trusted current run. */
export async function readTrustedCurrentRun(agentId: string, sessionId: string, signal: AbortSignal) {
    const response = await fetch(browserRunEndpoint(agentId, sessionId), { cache: 'no-store', signal })
    if (!response.ok) throw new Error('Could not check this run')
    const body = await readDesktopToolInstallBody(response, signal, 32768)
    return parseTrustedCurrentRun(body && typeof body === 'object' && 'trusted' in body ? body.trusted : null)
}

/** Same accepted check DesktopBrowserRun uses; never starts or ensures a runtime. */
export const httpCurrentRunCheck: CurrentRunCheck = async (run, signal) => {
    const current = await readTrustedCurrentRun(run.agentId, run.sessionId, signal)
    return sameRun(current, run) && current?.liveScreen ? { current: true, screen: 'running', site: current.liveScreen.site } : { current: false }
}

/** Accepted watch-only ticket (requireRunning: true refuses a stopped guest; no lease, no input). */
export const screenClientWatchTransport: PassiveViewerTransport = { requestWatchTicket: async (run, signal) => {
    const response = await fetch(browserRunEndpoint(run.agentId, run.sessionId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.runId }), signal })
    if (!response.ok) throw new Error('This run no longer owns the computer.')
    return await readDesktopToolInstallBody(response, signal, 8192) as Awaited<ReturnType<PassiveViewerTransport['requestWatchTicket']>>
} }
export async function readDesktopComputerPanelProjection(agentId: string, sessionId: string, signal: AbortSignal): Promise<ComputerPanelProjection> {
    const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/computer-panel`, { cache: 'no-store', signal })
    const value = computerPanelProjectionSchema.parse(await readDesktopToolInstallBody(response, signal, 32768))
    if (!response.ok || value.current && (value.current.agentId !== agentId || value.current.sessionId !== sessionId)) throw new Error('Computer owner changed')
    signal.throwIfAborted()
    return value
}
export const revalidateDesktopComputerPanelOwner: ComputerPanelPorts['revalidateOwner'] = async (owner, signal) => {
    const value = await readDesktopComputerPanelProjection(owner.agentId, owner.sessionId, signal)
    return !!value.current && sameRun(value.current, owner) && value.workspaceId === owner.workspaceId && value.generation === owner.generation && value.coworker.enabled && !value.coworker.deleted && value.runtime.kind === 'running'
}

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
        const response = await fetcher(`/api/desktop/agents/${encodeURIComponent(owner.agentId)}/sessions/${encodeURIComponent(owner.sessionId)}/computer-panel`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal,
            body: JSON.stringify({ requestId, runId: owner.runId, generation: owner.generation, app }),
        })
        const body = await readDesktopToolInstallBody(response, signal, 8192)
        if (!response.ok) throw new Error('The launch could not be confirmed. Retry the same request.')
        const result = computerPanelOutcomeSchema.parse(body)
        if (result.requestId !== requestId || result.app !== app || !result.acknowledged) throw new Error('Launcher acknowledgement changed')
        if (result.status === 'opened' || result.status === 'focused') return { status: result.status }
        if (result.status === 'app-missing') return { status: 'app-missing', reason: 'This app is not installed in the isolated guest.' }
        return { status: 'interrupted', reason: 'This app launch is not confirmed. Try again to inspect the same attempt.' }
    }
}

/** Revalidation over the accepted trusted current-run route plus the exact generation from root facts. */
export function createOwnerRevalidation(readFacts: ReadComputerPanelRootFacts = missingRootFacts): ComputerPanelPorts['revalidateOwner'] {
    return async (owner: ComputerPanelOwner, signal) => {
        const [current, facts] = await Promise.all([readTrustedCurrentRun(owner.agentId, owner.sessionId, signal), readFacts(owner.agentId, owner.sessionId, signal)])
        return !!current?.liveScreen && sameRun(current, owner) && facts.workspaceId === owner.workspaceId && facts.generation === owner.generation && facts.coworker.enabled && !facts.coworker.deleted
    }
}
