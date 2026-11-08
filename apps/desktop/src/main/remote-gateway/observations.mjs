import { sameIdentity, actor, UUID } from '../remote-machines/protocol.mjs'

/** Local provenance check only; never interprets or invents a remote frame protocol. */
export function acceptsRemoteObservation({ expectedActor, currentActor, capturedRuntime, currentRuntime, connection }) {
    try { actor(expectedActor); actor(currentActor) } catch { return false }
    if (['installId','workspaceId','launchNonce','rendererEpoch'].some(key => expectedActor[key] !== currentActor[key])) return false
    const before = capturedRuntime?.remoteMachine, after = currentRuntime?.remoteMachine
    return !!before && !!after && !!connection && UUID.test(currentRuntime.launchNonce)
        && currentRuntime.workspaceId === currentActor.workspaceId && capturedRuntime.workspaceId === currentActor.workspaceId
        && capturedRuntime.launchNonce === currentRuntime.launchNonce && before.lifetimeId === currentRuntime.launchNonce && after.lifetimeId === currentRuntime.launchNonce
        && before.connectionId === connection.connectionId && after.connectionId === connection.connectionId
        && before.configurationRevision === connection.revision && after.configurationRevision === connection.revision
        && sameIdentity(before.identity, connection.identity) && sameIdentity(after.identity, connection.identity)
        && (!connection.tlsPin || !before.tlsPin || connection.tlsPin === before.tlsPin)
        && (!connection.address || !before.address || connection.address === before.address)
}

/**
 * Saved health, including state "connected", is not a runtime result.
 * The only non-unknown admission is "admitted", and only for an applied receipt
 * whose lifetime matches the live binding. This never returns "connected".
 */
export function projectRuntimeBinding({ connection, runtime, publishedReceipt }) {
    const binding = runtime?.remoteMachine
    if (!binding) return 'not_connected'
    const value = publishedReceipt?.value
    if (publishedReceipt?.applied !== true || !value || binding.lifetimeId !== runtime.launchNonce || value.lifetimeId !== binding.lifetimeId) return 'unknown'
    if (!connection || binding.connectionId !== connection.connectionId || binding.configurationRevision !== connection.revision) return 'unknown'
    if (publishedReceipt.connectionId !== connection.connectionId || publishedReceipt.configurationRevision !== connection.revision) return 'unknown'
    if (!sameIdentity(binding.identity, connection.identity) || !sameIdentity(value.identity, connection.identity)) return 'unknown'
    return 'admitted'
}

export const REMOTE_GATEWAY_REQUIREMENTS = Object.freeze({
    protocol: 'Original public health/Bearer APIs lack a stable machine/workspace challenge proof; no compatible remote gateway is published.',
    custody: 'Root must bind the existing withCandidate and safeStorage custody to the exact operation and runtime lifetime.',
    lifecycle: 'canonicalRuntimePorts refuses drain, close, bind, verify and publish and does not call the supervisor. Root must not pass those methods into createRemoteSupervisorPorts; a present function passes preflight before the refusal.',
})
