import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CUSTOM_SERVER_KEY, PHONE_SESSION_KEY, createMacPairingClient, createMacSessionStore, createMemoryStorage, startSignInEntries } from '../src/index.mjs'

test('the start entries keep Use your own server and add Connect to This Mac beside it', () => {
    const entries = startSignInEntries()
    assert.equal(entries[1].label, 'Use your own server')
    assert.equal(entries[2].label, 'Connect to This Mac')
    assert.equal(entries[2].kind, 'mac-pairing')
})

test('writing a Mac session leaves cloud and self-hosted keys untouched', async () => {
    const storage = createMemoryStorage({
        [CUSTOM_SERVER_KEY]: '{"supabaseUrl":"https://example.supabase.co"}',
        'sb-auth-token': 'cloud',
        'rerun.workspace-id': '7',
    })
    const store = createMacSessionStore(storage)
    await store.write({ kind: 'rerun-mac-phone-pairing', status: 'approved', credential: 'mac-secret', origin: 'http://127.0.0.1:9' })
    const snapshot = storage.snapshot()
    assert.equal(snapshot[CUSTOM_SERVER_KEY], '{"supabaseUrl":"https://example.supabase.co"}')
    assert.equal(snapshot['sb-auth-token'], 'cloud')
    assert.equal(snapshot['rerun.workspace-id'], '7')
    assert.ok(snapshot[PHONE_SESSION_KEY].includes('mac-secret'))
    await store.clear()
    const after = storage.snapshot()
    assert.equal(after[PHONE_SESSION_KEY], undefined)
    assert.equal(after[CUSTOM_SERVER_KEY], '{"supabaseUrl":"https://example.supabase.co"}')
    assert.equal(after['sb-auth-token'], 'cloud')
})

test('credentials are bound to the original loopback origin and pairing response identity', async () => {
    const storage = createMemoryStorage()
    const offer = { kind: 'rerun-mac-phone-pairing', version: 1, macId: 'mac-a', fingerprint: 'fingerprint',
        offerId: 'offer', workspaceId: 1, origin: 'http://127.0.0.1:3001', secret: 'secret' }
    const calls = []
    const client = createMacPairingClient({
        storage,
        fetch: async (url, init) => {
            calls.push({ url, redirect: init.redirect })
            if (url.endsWith('/pair/redeem')) return Response.json({
                status: 'pending', deviceId: 'device', requestToken: 'request-token', workspaceId: 1,
            })
            return Response.json({ status: 'approved', deviceId: 'device', credential: 'device-token',
                macId: offer.macId, fingerprint: offer.fingerprint, workspaceId: 1, origin: 'http://127.0.0.1:3002' })
        },
    })
    await assert.rejects(client.connectToThisMac({ ...offer, origin: 'https://example.test' }), /invalid_origin/)
    assert.deepEqual(calls, [])
    await client.connectToThisMac(offer)
    await assert.rejects(client.waitForApproval(), /invalid_pairing_response/)
    assert.equal((await client.readMacSession()).status, 'pending')
    assert(calls.every(call => call.url.startsWith(offer.origin + '/') && call.redirect === 'error'))
})
