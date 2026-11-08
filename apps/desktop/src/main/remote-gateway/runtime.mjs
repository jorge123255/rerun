import { missing } from '../remote-machines/protocol.mjs'

/**
 * Hard gate in front of the existing supervisor.
 * These methods never call stop, confirmToolsStopped, listen, or a host.
 * Root must not pass them to createRemoteSupervisorPorts: a present function
 * passes preflight and can freeze the workspace before this refusal.
 */
export function canonicalRuntimePorts(supervisor) {
    void supervisor
    const refuse = () => { throw missing('W1-R-IDENTITY') }
    return {
        async drainWork(_context, signal) { signal?.throwIfAborted(); throw missing('W1-R-DRAINWORK') },
        async closeOwnedRuntime(_context, signal) { signal?.throwIfAborted(); throw missing('W1-R-CLOSEOWNEDRUNTIME') },
        bindRemote: refuse,
        verifyTarget: refuse,
        publishTarget: refuse,
    }
}
