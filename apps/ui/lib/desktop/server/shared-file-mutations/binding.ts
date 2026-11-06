import 'server-only'
import { DesktopHttpError } from '../auth'
import { readDesktopRuntime, canonicalDesktopEngineRoot, type DesktopRuntime } from '../runtime'
import type { getDesktopRemoteMcpService } from '../mcp-binding'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import type { SharedMutationAuthority } from './authority'

type Service = Awaited<ReturnType<typeof getDesktopRemoteMcpService>>
/** Reuse canonical run/grant/deletion admission, rather than creating another run authority. */
export function createDesktopSharedMutationAuthority(runtime: DesktopRuntime, service: Service): SharedMutationAuthority {
    const check = async (signal: AbortSignal) => {
        signal.throwIfAborted(); service.shutdownSignal.throwIfAborted(); assertDesktopWorkspaceAdmission(runtime)
        const current = await readDesktopRuntime()
        if (JSON.stringify([current.dataRoot,current.workspaceId,current.launchNonce,current.engine.origin]) !== JSON.stringify([runtime.dataRoot,runtime.workspaceId,runtime.launchNonce,runtime.engine.origin])) throw new DesktopHttpError(409, 'The shared-file workspace changed.')
        signal.throwIfAborted(); service.shutdownSignal.throwIfAborted(); assertDesktopWorkspaceAdmission(runtime)
    }
    return { async current(input, stop) {
        const signal = AbortSignal.any([stop, service.shutdownSignal])
        await check(signal)
        if (input.workspaceId !== runtime.workspaceId) throw new DesktopHttpError(409, 'The shared-file workspace changed.')
        const result: unknown = await service.authorizeRun(input, signal, 'sharedFilesWrite')
        const owner = typeof result === 'string' ? result : result && typeof result === 'object' && 'id' in result ? String(result.id) : null
        if (!owner) throw new DesktopHttpError(503, 'The shared-file owner could not be confirmed.')
        const engineRoot = await canonicalDesktopEngineRoot(runtime)
        await check(signal)
        return { workspaceId: runtime.workspaceId, owner, dataRoot: runtime.dataRoot, sharedRoot: `${engineRoot}/shared`, launchNonce: runtime.launchNonce, state: 'active', writeGrant: true }
    } }
}
