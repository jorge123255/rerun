import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteSupervisorPorts } from './supervisor-adapter.mjs'
import { actor, remoteIdentity } from './fixtures.mjs'

test('local runtime status is projected from the actual ready workspace owner, never a UI default', () => {
    const supervisor = { runtime: null, status: { state: 'ready' } }
    const ports = createRemoteSupervisorPorts({ supervisor, currentRenderer: () => null })
    assert.equal(ports.localState(actor).state, 'not_connected')
    supervisor.runtime = { workspaceId: actor.workspaceId, launchNonce: actor.launchNonce }
    assert.equal(ports.localState(actor).state, 'connected')
    supervisor.status.state = 'starting'
    assert.equal(ports.localState(actor).state, 'unknown')
    supervisor.status.state = 'ready'; supervisor.runtime.workspaceId = 2
    assert.equal(ports.localState(actor).state, 'unknown')
    supervisor.runtime.remoteMachine = {}
    assert.equal(ports.localState(actor).state, 'not_connected')
})

test('saved connection health cannot substitute for the exact active remote lifetime', () => {
    const connection = { connectionId: actor.installId, revision: actor.rendererEpoch, identity: remoteIdentity }
    const supervisor = { runtime: { workspaceId: actor.workspaceId, launchNonce: actor.launchNonce }, status: { state: 'ready' } }
    const ports = createRemoteSupervisorPorts({ supervisor, currentRenderer: () => null })
    assert.equal(ports.connectionState(actor, connection), 'not_connected')
    supervisor.runtime.remoteMachine = { connectionId: connection.connectionId, configurationRevision: connection.revision, identity: connection.identity, lifetimeId: actor.launchNonce }
    assert.equal(ports.connectionState(actor, connection), 'connected')
    supervisor.runtime.remoteMachine.lifetimeId = actor.rendererEpoch
    assert.equal(ports.connectionState(actor, connection), 'unknown')
    assert.throws(() => ports.assertAvailable(['freeze', 'bind_remote']), { code: 'authority_missing' })
})
