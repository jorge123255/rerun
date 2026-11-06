import 'server-only'
import { createHash } from 'node:crypto'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import type { DesktopVoiceService } from './service'
import { createDesktopVoiceRuntime } from './runtime'

const state = globalThis as typeof globalThis & { desktopVoiceBinding?: { identity: string; service: Promise<DesktopVoiceService> } }

/** One lazy authority for this exact authenticated app/engine launch, never a global unscoped service. */
export function desktopVoiceService(runtime: DesktopRuntime): Promise<DesktopVoiceService> {
    const identity = createHash('sha256').update(JSON.stringify([runtime.dataRoot, runtime.workspaceId, runtime.launchNonce, runtime.engine.origin, runtime.engine.apiKey, runtime.app.origin, runtime.app.sessionToken])).digest('hex')
    if (state.desktopVoiceBinding?.identity === identity) return state.desktopVoiceBinding.service
    const service = openDesktopDatabase(runtime.dataRoot).then(db => createDesktopVoiceRuntime(runtime, db, { isCurrent: () => state.desktopVoiceBinding?.identity === identity }))
    state.desktopVoiceBinding = { identity, service }
    void service.catch(() => { if (state.desktopVoiceBinding?.identity === identity) delete state.desktopVoiceBinding })
    return service
}
