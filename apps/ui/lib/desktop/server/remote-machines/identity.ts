import 'server-only'
import { z } from 'zod'
import { desktopRemoteIdentityProofSchema } from '../../../../../../packages/contracts/src/desktop-remote-machines'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'

/** Root mounts behind its existing engine-bearer channel; never browser session authentication. */
export async function remoteMachineIdentity(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const challenge = z.uuid().parse(new URL(request.url).searchParams.get('challenge'))
        const installId = (runtime as typeof runtime & { installId?: string }).installId
        if (!installId) throw new DesktopHttpError(503, 'Remote workspace identity is unavailable on this host.')
        request.signal.throwIfAborted()
        const proof = desktopRemoteIdentityProofSchema.parse({ identity: { protocolVersion: 1, machineId: installId, workspaceId: runtime.workspaceId }, challenge })
        return Response.json(proof, { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    } catch (error) {
        return Response.json({ error: 'The authenticated remote workspace identity could not be verified.' }, { status: error instanceof DesktopHttpError ? error.status : 400 })
    }
}
