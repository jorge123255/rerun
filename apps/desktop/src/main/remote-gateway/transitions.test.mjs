import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRemoteTransitionGate } from './transitions.mjs'
const fixture = () => {
    const acceptedBy = { installId: randomUUID(), workspaceId: 1, launchNonce: randomUUID(), rendererEpoch: randomUUID() }
    const receipt = { ...acceptedBy, requestId: randomUUID(), receiptId: randomUUID(), connectionId: randomUUID(), configurationRevision: randomUUID(), effectGeneration: 0, kind: 'select' }
    const context = { installId: acceptedBy.installId, workspaceId: 1, requestId: receipt.requestId, receiptId: receipt.receiptId, connectionId: receipt.connectionId, configurationRevision: receipt.configurationRevision, effectGeneration: 0, kind: 'select', target: null, selectedBefore: false, fromLaunchNonce: acceptedBy.launchNonce, effectId: `${receipt.receiptId}:0:freeze` }
    let state = { installId: acceptedBy.installId, workspaceId: 1, operations: [{ receipt, acceptedBy, selectedBefore: false, target: null, effects: {} }] }
    const store = { read: async () => structuredClone(state), mutate: async change => { const copy = structuredClone(state); const result = change(copy); state = copy; return result } }
    return { context, store, state: () => state, gate: createRemoteTransitionGate({ store, assertActor: async actor => assert.deepEqual(actor, acceptedBy) }) }
}
test('reserves before effects and recovers the same receipt without invoking a duplicate', async () => {
    const f = fixture(); let calls = 0
    const effect = async () => { calls++; assert.equal(f.state().operations[0].lifecycleEffects[f.context.effectId].state, 'reserved'); return {} }
    const first = await f.gate.apply('freeze', f.context, effect, new AbortController().signal)
    assert.deepEqual(await f.gate.apply('freeze', f.context, effect, new AbortController().signal), first)
    assert.equal(calls, 1)
})
test('a failed or interrupted effect remains unknown across owner restart and is never replayed', async () => {
    const f = fixture(); let calls = 0
    await assert.rejects(f.gate.apply('freeze', f.context, async () => { calls++; throw new Error('lost ACK') }, new AbortController().signal))
    const restored = createRemoteTransitionGate({ store: f.store, assertActor: async () => {} })
    assert.equal((await restored.lookupEffect(f.context, new AbortController().signal)).state, 'unknown')
    await assert.rejects(restored.apply('freeze', f.context, async () => { calls++; return {} }, new AbortController().signal))
    assert.equal(calls, 1)
})
test('refuses wrong owner, changed target/configuration and actor epochs before effects', async () => {
    const f = fixture(); let calls = 0
    for (const altered of [{ ...f.context, workspaceId: 2 }, { ...f.context, configurationRevision: randomUUID() }, { ...f.context, fromLaunchNonce: randomUUID() }]) await assert.rejects(f.gate.apply('freeze', altered, async () => { calls++; return {} }, new AbortController().signal))
    assert.equal(calls, 0)
})
test('retains a reserved effect and custody when shutdown interrupts an unacknowledged callback', async () => {
    const f = fixture(); let release
    const started = f.gate.apply('freeze', f.context, () => new Promise(resolve => { release = resolve }), new AbortController().signal)
    while (!release) await Promise.resolve()
    const closing = f.gate.close()
    await assert.rejects(started)
    release({}); await closing
    assert.equal(f.state().operations[0].lifecycleEffects[f.context.effectId].state, 'reserved')
})
test('a credential or oversized payload is not stored and does not become an applied effect', async () => {
    const f = fixture()
    const key = 'super-secret-key-value-000'
    const signal = new AbortController().signal
    await assert.rejects(f.gate.apply('freeze', { ...f.context, apiKey: key, blob: 'x'.repeat(20000) }, async () => ({ apiKey: key }), signal))
    const saved = JSON.stringify(f.state())
    assert.equal(saved.includes(key), false)
    assert.equal(saved.includes('x'.repeat(100)), false)
    assert.notEqual(f.state().operations[0].lifecycleEffects[f.context.effectId].state, 'applied')
})
