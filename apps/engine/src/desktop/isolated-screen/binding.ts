import { currentScreenRun } from './run-owner.js'
import { readAgentConfig } from '../../agents/loader.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { createIsolatedViewer } from '../isolated-viewer.js'
import { IsolatedScreenRefusal, service } from './index.js'
import type { ScreenOwner, ScreenTarget } from './types.js'
import { screenGranted } from './permissions.js'
export { screenGranted, screenPermissionsRevoked } from './permissions.js'

let viewer: ReturnType<typeof createIsolatedViewer> | undefined
let launchNonce: string | undefined
const targets = new Map<string, ScreenTarget>()
const controllers = new Map<string, AbortController>()
const starting = new Map<string, Set<Promise<unknown>>>()
const revoking = new Set<string>()
export function isolatedScreenSignal(id: string, signal: AbortSignal) {
    if (revoking.has(id)) throw new Error('The screen is stopping.')
    let controller = controllers.get(id)
    if (!controller || controller.signal.aborted) { controller = new AbortController(); controllers.set(id, controller) }
    return AbortSignal.any([signal, controller.signal])
}
export function isolatedScreenOwner(engineAgentId: string): ScreenOwner {
    if (!launchNonce) throw new Error('The isolated screen is not ready.')
    return { engineAgentId, launchNonce }
}
export async function requireComputerScreenGrant(engineAgentId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (revoking.has(engineAgentId) || desktopDeletionActive(engineAgentId)) throw new Error('Coworker is being stopped or deleted.')
    const config = await readAgentConfig(engineAgentId)
    signal.throwIfAborted()
    if (!screenGranted(config)) throw new Error('Enable computer control and an isolated app for this coworker.')
}
export async function requireScreenGrant(engineAgentId: string, signal: AbortSignal) {
    await requireComputerScreenGrant(engineAgentId, signal)
    const config = await readAgentConfig(engineAgentId)
    signal.throwIfAborted()
    if (!hasDesktopToolGrant(config, 'browser')) throw new Error('Enable browser access for this coworker.')
}
export function bindIsolatedScreen(runtime: { launchNonce: string; app: { origin: string } }) {
    launchNonce = runtime.launchNonce
    const screen = service()
    viewer = createIsolatedViewer({
        ...screen,
        async status(owner, signal) {
            const status = await screen.status(owner, signal)
            const active = status.state === 'running' || status.state === 'human' ? await screen.running(owner, signal).catch(() => null) : null
            return { state: !status.available ? 'unavailable' : status.state === 'human' ? 'taken-over' : status.state === 'starting' ? 'starting' : 'available', driving: status.state === 'human',
                ...(status.launchers && { launchers: status.launchers }),
                running: !!active, currentRun: active ? currentScreenRun(owner.engineAgentId) : null, ...(active && { sessionGeneration: active.target.sessionGeneration, width: active.width, height: active.height }),
                ...(!status.available && { reason: status.prerequisite === 'docker-missing' ? 'Install and open Docker Desktop to use this coworker’s isolated browser.' : status.prerequisite === 'daemon-unreachable' ? 'Open Docker Desktop to use this coworker’s isolated browser.' : status.prerequisite === 'image-missing' ? 'The isolated browser image has not been installed.' : 'The isolated browser is not available on this machine.' }) }
        },
        ensure: (owner, signal) => ensureIsolatedScreen(owner.engineAgentId, signal),
        async navigate(target, input, signal) { await requireScreenGrant(target.engineAgentId, signal); return screen.navigate(target, input, signal) },
        async startTakeover(target, signal) { return (await screen.startTakeover(target, signal)).token },
        async finishTakeover(target, token, signal) {
            try { return await screen.finishTakeover(target, { token }, signal) }
            catch (error) { if (error instanceof IsolatedScreenRefusal && error.kind === 'stale') return { url: null, expired: true }; throw error }
        },
    }, { launchNonce, uiOrigin: runtime.app.origin, currentRun: owner => currentScreenRun(owner.engineAgentId), authorize: (owner, _mode, signal) => requireComputerScreenGrant(owner.engineAgentId, signal) })
    return viewer
}
export async function ensureIsolatedScreen(engineAgentId: string, signal: AbortSignal) {
    signal = isolatedScreenSignal(engineAgentId, signal)
    const work = (async () => {
    await requireComputerScreenGrant(engineAgentId, signal)
    const result = await service().ensure(isolatedScreenOwner(engineAgentId), signal)
    targets.set(engineAgentId, result.target)
    await requireComputerScreenGrant(engineAgentId, signal)
    return result
    })()
    const set = starting.get(engineAgentId) ?? new Set(); starting.set(engineAgentId, set); set.add(work)
    try { return await work } finally { set.delete(work); if (!set.size) starting.delete(engineAgentId) }
}
export async function revokeIsolatedScreen(engineAgentId: string, dispose = false) {
    if (!launchNonce) return
    revoking.add(engineAgentId)
    controllers.get(engineAgentId)?.abort()
    const owner = isolatedScreenOwner(engineAgentId)
    try {
        await Promise.allSettled([viewer?.revoke(owner), ...starting.get(engineAgentId) ?? []])
        const target = targets.get(engineAgentId)
        if (dispose) await service().dispose(owner, AbortSignal.timeout(15_000))
        else if (target) await service().stop(target, AbortSignal.timeout(15_000))
        targets.delete(engineAgentId)
    } finally { revoking.delete(engineAgentId) }
}
