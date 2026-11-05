import type { AgentConfig } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { createIsolatedViewer } from '../isolated-viewer.js'
import { service } from './index.js'
import type { ScreenOwner, ScreenTarget } from './types.js'

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
export function screenGranted(config: AgentConfig) {
    return config.enabled && hasDesktopToolGrant(config, 'browser') && hasDesktopToolGrant(config, 'computer')
}
export async function requireScreenGrant(engineAgentId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (revoking.has(engineAgentId) || desktopDeletionActive(engineAgentId)) throw new Error('Coworker is being stopped or deleted.')
    const config = await readAgentConfig(engineAgentId)
    signal.throwIfAborted()
    if (!screenGranted(config)) throw new Error('Enable browser and computer control for this coworker.')
}
export function bindIsolatedScreen(runtime: { launchNonce: string; app: { origin: string } }) {
    launchNonce = runtime.launchNonce
    const screen = service()
    viewer = createIsolatedViewer({
        ...screen,
        async status(owner, signal) {
            const status = await screen.status(owner, signal)
            return { state: !status.available ? 'unavailable' : status.state === 'human' ? 'taken-over' : status.state === 'starting' ? 'starting' : 'available', driving: status.state === 'human',
                ...(!status.available && { reason: status.prerequisite === 'docker-missing' ? 'Install and open Docker Desktop to use this coworker’s isolated browser.' : status.prerequisite === 'daemon-unreachable' ? 'Open Docker Desktop to use this coworker’s isolated browser.' : status.prerequisite === 'image-missing' ? 'The isolated browser image has not been installed.' : 'The isolated browser is not available on this machine.' }) }
        },
        ensure: (owner, signal) => ensureIsolatedScreen(owner.engineAgentId, signal),
        async startTakeover(target, signal) { return (await screen.startTakeover(target, signal)).token },
        finishTakeover: (target, token, signal) => screen.finishTakeover(target, { token }, signal),
    }, { launchNonce, uiOrigin: runtime.app.origin, authorize: (owner, _mode, signal) => requireScreenGrant(owner.engineAgentId, signal) })
    return viewer
}
export async function ensureIsolatedScreen(engineAgentId: string, signal: AbortSignal) {
    signal = isolatedScreenSignal(engineAgentId, signal)
    const work = (async () => {
    await requireScreenGrant(engineAgentId, signal)
    const result = await service().ensure(isolatedScreenOwner(engineAgentId), signal)
    targets.set(engineAgentId, result.target)
    await requireScreenGrant(engineAgentId, signal)
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
