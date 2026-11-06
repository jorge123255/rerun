import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fixture, actor, FIXTURE_KEY, remoteIdentity } from './fixtures.mjs'
const select = f => ({ action: 'select', actor, requestId: randomUUID(), connectionId: f.state().connection.connectionId, expectedRevision: f.state().connection.revision })
const recover = (input, receipt) => ({ action: 'recover', actor, requestId: input.requestId, resume: true, expectedReceiptRevision: receipt.revision })
test('pair proves the server, masks credentials and reads/replays without network or activation', async () => {
    const f = fixture(), paired = await f.coordinator.execute(f.pair)
    assert.equal(paired.ok, true); assert.equal(paired.snapshot.selected, false); assert.equal(f.calls.length, 0)
    assert.equal(f.probes.length, 1); assert.equal(JSON.stringify(paired).includes(FIXTURE_KEY), false)
    assert.equal(JSON.stringify(f.state()).includes(FIXTURE_KEY), false)
    await f.coordinator.execute({ action: 'reconcile', actor, requestId: f.pair.requestId })
    await f.coordinator.execute(f.pair)
    assert.equal(f.probes.length, 1); assert.equal(f.calls.length, 0)
    const drift = await f.coordinator.execute({ ...f.pair, apiKey: 'different-synthetic-server-key-000000' })
    assert.equal(drift.code, 'stale')
})
test('select requires freeze/flush/drain/close/verified publication in order', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair)
    const selected = await f.coordinator.execute(select(f))
    assert.equal(selected.ok, true); assert.equal(selected.snapshot.selected, true)
    assert.deepEqual(f.calls.map(c => c.name), ['freeze', 'flush', 'drain', 'close', 'bind_remote', 'verify', 'publish', 'unfreeze'])
    const bound = f.calls.find(c => c.name === 'bind_remote').ctx
    await f.coordinator.withCandidate(bound, async value => { assert.equal(value.apiKey, FIXTURE_KEY) }, new AbortController().signal)
})
test('lost bind ACK survives restart and recovery never repeats an applied bind', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair); f.loseAck('bind_remote')
    const input = select(f), failed = await f.coordinator.execute(input)
    assert.equal(failed.ok, false); assert.equal(failed.receipt.phase, 'failed_after_drain'); assert.equal(failed.receipt.requiresRecovery, true)
    const restarted = f.create(), before = f.calls.length
    await restarted.execute({ action: 'read', actor, requestId: input.requestId })
    assert.equal(f.calls.length, before)
    const resumed = await restarted.execute(recover(input, failed.receipt))
    assert.equal(resumed.ok, true); assert.equal(f.calls.filter(c => c.name === 'bind_remote').length, 1)
})
test('confirmed rollback before drain starts a new effect generation and retains the original identities', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair); f.loseAck('freeze')
    const input = select(f), failed = await f.coordinator.execute(input)
    assert.equal(failed.receipt.phase, 'failed_before_drain'); assert.equal(failed.receipt.closeAttempted, false)
    const resumed = await f.coordinator.execute(recover(input, failed.receipt))
    assert.equal(resumed.ok, true); assert.equal(resumed.receipt.effectGeneration, 1)
    const op = f.state().operations.find(o => o.receipt.requestId === input.requestId)
    assert.equal(op.history.length, 1); assert.equal(f.calls.filter(c => c.name === 'freeze').length, 2)
})
test('wrong owner/revision/renderer and remote identity drift refuse before destructive effects', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair)
    assert.equal((await f.coordinator.execute({ ...select(f), expectedRevision: randomUUID() })).code, 'stale')
    assert.equal((await f.coordinator.execute({ ...select(f), actor: { ...actor, rendererEpoch: randomUUID() } })).code, 'stale')
    f.setIdentity({ ...remoteIdentity, machineId: randomUUID() })
    assert.equal((await f.coordinator.execute(select(f))).code, 'identity_changed'); assert.equal(f.calls.length, 0)
})
test('Remove needs exact confirmation/revision, closes only local custody and keeps replay receipts', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair)
    const input = { ...select(f), action: 'remove', confirmation: 'Remove' }
    assert.equal((await f.coordinator.execute({ ...input, confirmation: 'yes' })).code, 'invalid')
    const removed = await f.coordinator.execute(input)
    assert.equal(removed.ok, true); assert.equal(f.state().connection, null)
    assert.deepEqual(f.calls.map(c => c.name), ['close'])
    assert.equal(f.state().operations.find(o => o.receipt.requestId === f.pair.requestId).candidate.sealedKey, null)
    const before = f.calls.length; await f.coordinator.execute(input); assert.equal(f.calls.length, before)
})
test('unknown effect receipts block recovery rather than re-running an uncertain lifecycle call', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair); f.loseAck('close')
    const input = select(f), failed = await f.coordinator.execute(input)
    f.ports.lookupEffect = async () => ({ state: 'unknown' })
    const before = f.calls.length, recovered = await f.create().execute(recover(input, failed.receipt))
    assert.equal(recovered.ok, false); assert.equal(f.calls.length, before); assert.equal(f.state().selected, false)
})
test('Stop during a pending proof prevents late publication and retained reads never restart it', async () => {
    const f = fixture(); let entered, finish
    const began = new Promise(resolve => { entered = resolve })
    f.client.probe = async () => { entered(); return new Promise(resolve => { finish = resolve }) }
    const pending = f.coordinator.execute(f.pair); await began
    const stopping = f.coordinator.execute({ action: 'cancel', actor, requestId: f.pair.requestId })
    finish({ address: f.pair.address, identity: remoteIdentity, tlsPin: 'a'.repeat(64), health: { state: 'connected', checkedAt: new Date().toISOString(), commit: null, activeAgents: 0, reason: null } })
    await pending; const stopped = await stopping
    assert.equal(stopped.ok, false); assert.equal(f.state().connection, null); assert.equal(f.calls.length, 0)
    const snapshot = await f.create().execute({ action: 'reconcile', actor, requestId: f.pair.requestId })
    assert.equal(snapshot.ok, true); assert.equal(snapshot.snapshot.connection, null)
})
test('offline health is cached as a failure and an explicit exact-revision recovery may retry safely', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair)
    const original = f.client.probe; f.client.probe = async () => { throw Object.assign(new Error('Synthetic offline'), { code: 'unavailable' }) }
    const input = { ...select(f), action: 'health' }, failed = await f.coordinator.execute(input)
    assert.equal(failed.ok, false); assert.equal(f.state().connection.health.state, 'unreachable')
    f.client.probe = original
    const retried = await f.create().execute(recover(input, failed.receipt))
    assert.equal(retried.ok, true); assert.equal(f.state().connection.health.state, 'connected')
})
test('request receipts are never evicted to make room for another pairing attempt', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair)
    await f.store.mutate(state => { const original = state.operations[0]; for (let n = 1; n < 128; n++) state.operations.push({ ...structuredClone(original), receipt: { ...original.receipt, requestId: randomUUID(), receiptId: randomUUID() } }) })
    const before = f.state().operations.map(o => o.receipt.requestId)
    assert.equal((await f.coordinator.execute(select(f))).code, 'storage_full')
    assert.deepEqual(f.state().operations.map(o => o.receipt.requestId), before)
})
test('native errors cannot leak raw server keys into failure snapshots or saved reasons', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair)
    f.ports.effect = async () => { throw Object.assign(new Error(`Unsafe native detail ${FIXTURE_KEY}`), { code: 'unavailable' }) }
    const result = await f.coordinator.execute(select(f))
    assert.equal(JSON.stringify(result).includes(FIXTURE_KEY), false)
    assert.equal(JSON.stringify(f.state()).includes(FIXTURE_KEY), false)
})
test('a persisted active receipt remains distinct from observational connection state after restart', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair)
    const selected = await f.coordinator.execute(select(f))
    assert.equal(selected.snapshot.activeReceipt.configurationRevision, selected.snapshot.connection.revision)
    const restarted = await f.create().execute({ action: 'read', actor, requestId: selected.receipt.requestId })
    assert.equal(restarted.snapshot.selected, true); assert.equal(restarted.snapshot.runtimeState, 'unknown')
    assert.equal(restarted.receipt.requestId, selected.receipt.requestId)
})
test('an inactive connection close with a lost ACK still blocks competing changes until exact recovery', async () => {
    const f = fixture(); await f.coordinator.execute(f.pair); f.loseAck('close')
    const input = { ...select(f), action: 'remove', confirmation: 'Remove' }, failed = await f.coordinator.execute(input)
    assert.equal(failed.receipt.requiresRecovery, true); assert.equal(f.state().connection !== null, true)
    const recovered = await f.create().execute(recover(input, failed.receipt))
    assert.equal(recovered.ok, true); assert.equal(f.calls.filter(c => c.name === 'close').length, 1)
    assert.equal(f.state().connection, null)
})
