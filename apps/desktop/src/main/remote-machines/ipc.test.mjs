import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRemoteMachineIpc } from './ipc.mjs'
import { actor } from './fixtures.mjs'

const event = { trusted: true }
const command = () => ({ action: 'read', actor, requestId: randomUUID() })
function fixture(execute = async () => ({ ok: true, snapshot: { actor }, receipt: null })) {
    let current = { actor, binding: { execute } }
    const ipc = createRemoteMachineIpc({ trusted: event => { if (!event?.trusted) throw new Error('private diagnostic') }, context: () => current })
    return { ipc, setCurrent: value => { current = value }, current: () => current }
}

test('native remote bridge supplies only the current main-issued actor', async () => {
    const { ipc, setCurrent } = fixture()
    assert.deepEqual(await ipc.actor(event), actor)
    const copy = await ipc.actor(event); copy.workspaceId = 9
    assert.equal((await ipc.actor(event)).workspaceId, 1)
    await assert.rejects(ipc.actor({ trusted: false }), /Servers are unavailable/)
    setCurrent(null)
    await assert.rejects(ipc.actor(event), /Servers are unavailable/)
})

test('untrusted, foreign renderer and oversized requests never reach the native binding', async () => {
    let calls = 0
    const { ipc } = fixture(async () => { calls++; return { ok: true } })
    assert.equal((await ipc.execute({ trusted: false }, command())).ok, false)
    assert.equal((await ipc.execute(event, { ...command(), actor: { ...actor, rendererEpoch: randomUUID() } })).code, 'stale')
    assert.equal((await ipc.execute(event, { ...command(), extra: 'x'.repeat(17000) })).code, 'invalid')
    assert.equal(calls, 0)
})

test('current read commands use the exact native binding without changing their envelope', async () => {
    const input = command(); let seen
    const { ipc } = fixture(async value => { seen = value; return { ok: true, receipt: null } })
    assert.equal((await ipc.execute(event, input)).ok, true)
    assert.deepEqual(seen, input)
})

test('late mutation acknowledgements preserve the same operation receipt as uncertain after renderer disposal', async () => {
    const requestId = randomUUID(), receipt = { requestId }
    let release
    const { ipc, setCurrent, current } = fixture(() => new Promise(resolve => { release = resolve }))
    const input = { action: 'pair', actor, requestId, connectionId: randomUUID(), expectedRevision: 'unconfigured', address: 'https://machine.example', apiKey: 'synthetic-test-key-12345678' }
    const pending = ipc.execute(event, input)
    setCurrent({ ...current(), actor: { ...actor, rendererEpoch: randomUUID() } })
    release({ ok: true, receipt })
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'uncertain')
    assert.deepEqual(result.receipt, receipt)
    assert.equal(JSON.stringify(result).includes(input.apiKey), false)
})

test('native exceptions never expose credentials or raw transport diagnostics', async () => {
    const { ipc } = fixture(async () => { throw new Error('secret engine key and filesystem details') })
    const result = await ipc.execute(event, command())
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unavailable')
    assert.equal(JSON.stringify(result).includes('secret'), false)
})
