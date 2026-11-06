import 'server-only'
import {
    desktopRemoteCommandSchema, desktopRemoteResultSchema, DESKTOP_REMOTE_MACHINE_LIMITS,
    type DesktopRemoteMachineBridge, type DesktopRemoteActor,
} from '../../../../../../packages/contracts/src/desktop-remote-machines'
import { readDesktopJson } from '../request-json'
import { DesktopHttpError } from '../auth'
const sameActor = (a: DesktopRemoteActor, b: DesktopRemoteActor) => a.installId === b.installId && a.workspaceId === b.workspaceId && a.launchNonce === b.launchNonce && a.rendererEpoch === b.rendererEpoch
/** Optional root-native bridge. H may instead consume the same contract directly over trusted IPC. */
export function remoteMachineHandlers(bridge: DesktopRemoteMachineBridge, currentActor: () => Promise<DesktopRemoteActor>) {
    return { async post(request: Request) {
        try {
            const parsed = desktopRemoteCommandSchema.safeParse(await readDesktopJson(request, DESKTOP_REMOTE_MACHINE_LIMITS.requestBytes))
            if (!parsed.success) throw new DesktopHttpError(400, 'This server request was not understood.')
            const input = parsed.data
            if (!sameActor(input.actor, await currentActor())) throw new DesktopHttpError(409, 'This workspace window is no longer current.')
            const result = desktopRemoteResultSchema.parse(await bridge.execute(input, request.signal))
            if (!sameActor(input.actor, await currentActor())) throw new DesktopHttpError(409, 'This workspace window changed. Reconcile the same request from the new window.')
            if (result.ok && !sameActor(result.snapshot.actor, input.actor)) throw new DesktopHttpError(409, 'The server acknowledgement belongs to another workspace instance.')
            return Response.json(result, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            return Response.json({ error: error instanceof DesktopHttpError ? error.message : 'The server request was not confirmed. Read this same request before retrying.' }, { status: error instanceof DesktopHttpError ? error.status : 503 })
        }
    } }
}
