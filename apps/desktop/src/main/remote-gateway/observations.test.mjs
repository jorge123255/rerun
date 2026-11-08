import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { acceptsRemoteObservation, projectRuntimeBinding } from './observations.mjs'
test('rejects old frames/observations after runtime, workspace, renderer or configuration changes', () => {
    const actor = { installId: randomUUID(), workspaceId: 1, launchNonce: randomUUID(), rendererEpoch: randomUUID() }
    const connection = { connectionId: randomUUID(), revision: randomUUID(), identity: { protocolVersion: 1, machineId: randomUUID(), workspaceId: 1 } }
    const runtime = { launchNonce: actor.launchNonce, workspaceId: 1, remoteMachine: { connectionId: connection.connectionId, configurationRevision: connection.revision, identity: connection.identity, lifetimeId: actor.launchNonce } }
    const input = { expectedActor: actor, currentActor: actor, capturedRuntime: runtime, currentRuntime: runtime, connection }
    assert.equal(acceptsRemoteObservation(input), true)
    assert.equal(acceptsRemoteObservation({ ...input, currentActor: { ...actor, rendererEpoch: randomUUID() } }), false)
    assert.equal(acceptsRemoteObservation({ ...input, currentRuntime: { ...runtime, launchNonce: randomUUID() } }), false)
    assert.equal(acceptsRemoteObservation({ ...input, connection: { ...connection, revision: randomUUID() } }), false)
    assert.equal(acceptsRemoteObservation({ ...input, connection: null }), false)
    const pinned = { ...connection, tlsPin: 'a'.repeat(64), address: 'https://files.example' }
    const pinnedRuntime = { ...runtime, remoteMachine: { ...runtime.remoteMachine, tlsPin: pinned.tlsPin, address: pinned.address } }
    const pinnedInput = { ...input, connection: pinned, capturedRuntime: pinnedRuntime, currentRuntime: pinnedRuntime }
    assert.equal(acceptsRemoteObservation(pinnedInput), true)
    assert.equal(acceptsRemoteObservation({ ...pinnedInput, connection: { ...pinned, tlsPin: 'b'.repeat(64) } }), false)
    assert.equal(acceptsRemoteObservation({ ...pinnedInput, connection: { ...pinned, address: 'https://other.example' } }), false)
})

test('never reports connected from saved health or an unbound runtime', () => {
    const connection = { connectionId: randomUUID(), revision: randomUUID(), identity: { protocolVersion: 1, machineId: randomUUID(), workspaceId: 1 }, health: { state: 'connected' } }
    assert.equal(projectRuntimeBinding({ connection, runtime: null, publishedReceipt: null }), 'not_connected')
    const runtime = { launchNonce: randomUUID(), workspaceId: 1, remoteMachine: { connectionId: connection.connectionId, configurationRevision: connection.revision, identity: connection.identity, lifetimeId: randomUUID() } }
    assert.equal(projectRuntimeBinding({ connection, runtime, publishedReceipt: null }), 'unknown')
    const publishedReceipt = { applied: true, connectionId: connection.connectionId, configurationRevision: connection.revision, value: { lifetimeId: runtime.launchNonce, identity: connection.identity } }
    const admitted = { ...runtime, remoteMachine: { ...runtime.remoteMachine, lifetimeId: runtime.launchNonce } }
    assert.equal(projectRuntimeBinding({ connection, runtime: admitted, publishedReceipt }), 'admitted')
    assert.notEqual(projectRuntimeBinding({ connection, runtime: admitted, publishedReceipt }), 'connected')
})
