import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalRuntimePorts } from './runtime.mjs'

test('drain, close and publication refuse without calling the supervisor or a host', async () => {
    let drains = 0, stops = 0
    const ports = canonicalRuntimePorts({
        runtime: { remoteMachine: { connectionId: 'present' }, launchNonce: 'local' },
        confirmToolsStopped: async () => { drains++ },
        stop: async () => { stops++ },
    })
    const signal = new AbortController().signal
    for (const call of [
        () => ports.drainWork({ kind: 'select' }, signal),
        () => ports.closeOwnedRuntime({ kind: 'remove', selectedBefore: true }, signal),
        () => ports.bindRemote(),
        () => ports.verifyTarget(),
        () => ports.publishTarget(),
    ]) await assert.rejects(async () => call(), error => error.code === 'authority_missing')
    assert.equal(drains, 0)
    assert.equal(stops, 0)
})
