import { createRemoteMachineStore } from './store.mjs'
import { createSafeStorageCustody } from './credentials.mjs'
import { createRemoteProtocolClient } from './network.mjs'
import { createRemoteMachineCoordinator } from './coordinator.mjs'
import { createRemoteSupervisorPorts } from './supervisor-adapter.mjs'
import { command, refusal, publicFailure } from './protocol.mjs'

/** One binding owned by root's existing main-process lifetime; construction has no effects. */
export function createNativeRemoteMachines(options) {
    const coordinators = new Map()
    const custody = createSafeStorageCustody({ safeStorage: options.safeStorage, workspaceKey: options.workspaceKey })
    const ports = createRemoteSupervisorPorts(options), client = options.client ?? createRemoteProtocolClient()
    const get = workspaceId => {
        if (!coordinators.has(workspaceId)) coordinators.set(workspaceId, createRemoteMachineCoordinator({
            store: createRemoteMachineStore({ dataRoot: options.dataRoot, installId: options.installId, workspaceId }), custody, client, ports,
        }))
        return coordinators.get(workspaceId)
    }
    async function closeWorkspace(workspaceId) {
        const coordinator = coordinators.get(workspaceId)
        if (!coordinator) return
        await coordinator.close()
        if (coordinators.get(workspaceId) === coordinator) coordinators.delete(workspaceId)
    }
    return {
        async execute(raw, signal = new AbortController().signal) {
            let input, result
            try { input = command(raw) } catch {
                return { ok: false, code: 'invalid', message: 'This server request was not understood.', receipt: null }
            }
            try {
                await ports.checkActor(input.actor, signal)
                result = await get(input.actor.workspaceId).execute(input, signal)
                if (result.ok) {
                    await ports.checkActor(input.actor, signal)
                    result.snapshot.runtimeState = ports.connectionState(input.actor, result.snapshot.connection)
                    result.snapshot.localRuntime = ports.localState(input.actor)
                }
                return result
            }
            catch (error) { return { ok: false, ...publicFailure(result?.receipt ? refusal('uncertain', 'This workspace changed before the server acknowledgement.') : error), receipt: result?.receipt ?? null } }
        },
        async withCandidate(context, consume, signal) {
            const coordinator = coordinators.get(context.workspaceId)
            if (!coordinator) throw refusal('authority_missing', 'The exact remote activation request is unavailable.', 'W1-R-TRANSITION')
            return coordinator.withCandidate(context, consume, signal)
        },
        closeWorkspace,
        async close() { for (const workspaceId of coordinators.keys()) await closeWorkspace(workspaceId) },
    }
}
