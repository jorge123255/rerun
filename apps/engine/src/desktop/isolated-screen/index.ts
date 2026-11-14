import { createDockerCli } from './docker-cli.js'
import { encodeScreenJpeg } from './encode.js'
import { createIsolatedScreenService } from './service.js'
import { authorizeScreenInput } from './permissions.js'
import { knownUnusedScreen, recordPossibleScreenResources } from './ownership.js'
import type { IsolatedScreenService, ScreenOwner } from './types.js'

export { GUEST_IMAGE, GUEST_PLATFORM } from './docker-args.js'
export { IsolatedScreenRefusal } from './refusal.js'
export { createIsolatedScreenService } from './service.js'
export type { IsolatedScreenDeps, JpegEncoder } from './service.js'
export type { DockerClient, DockerImage, DockerVersion, InspectedContainer, InspectedVolume, ListedScreen } from './docker-cli.js'
export type {
    EnsuredScreen,
    IsolatedScreenService,
    ScreenAction,
    ScreenComputerInput,
    ScreenLease,
    ScreenLink,
    ScreenNavigate,
    ScreenOwner,
    ScreenPage,
    ScreenPrerequisite,
    ScreenReconcile,
    ScreenRunState,
    ScreenShot,
    ScreenStatus,
    ScreenTakeover,
    ScreenTarget,
    ViewerMode,
} from './types.js'

let shared: IsolatedScreenService | undefined

export function service(): IsolatedScreenService {
    shared ??= createIsolatedScreenService({ docker: createDockerCli(), encodeJpeg: encodeScreenJpeg, authorizeInput: authorizeScreenInput, knownUnusedScreen, recordPossibleScreenResources })
    return shared
}

export function shutdownIsolatedScreens(signal: AbortSignal): Promise<Awaited<ReturnType<IsolatedScreenService['shutdown']>>> {
    return service().shutdown(signal)
}

export function reconcileIsolatedScreens(launchNonce: string, signal: AbortSignal): Promise<Awaited<ReturnType<IsolatedScreenService['reconcile']>>> {
    return service().reconcile(launchNonce, signal)
}

export function disposeIsolatedScreen(owner: ScreenOwner, signal: AbortSignal): Promise<void> {
    return service().dispose(owner, signal)
}
