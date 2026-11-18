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
            return Response.json({ status: 'approved', deviceId: 'device', credential: 'a'.repeat(43),
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

test('a cancelled pairing request cannot persist its late response', async () => {
    const storage = createMemoryStorage()
    const controller = new AbortController()
    let requestSignal
    let respond
    const reply = new Promise(resolve => { respond = resolve })
    const client = createMacPairingClient({
        storage,
        pinnedFetch: async (_url, _fingerprint, options) => {
            requestSignal = options.signal
            return reply
        },
    })
    const pending = client.connectToThisMac({ kind: 'rerun-mac-phone-pairing', version: 1, macId: 'mac-a',
        fingerprint: 'device-fingerprint', certificateFingerprint: 'a'.repeat(64), offerId: 'offer',
        workspaceId: 1, origin: 'https://192.168.0.2:3001', secret: 'secret' }, controller.signal)
    controller.abort()
    assert.equal(requestSignal.aborted, true)
    respond(Response.json({ status: 'pending', deviceId: 'device', requestToken: 'test-token', workspaceId: 1 }))
    await assert.rejects(pending, /aborted/)
    assert.equal(await client.readMacSession(), null)
})

test('the Chief of Staff is asked for by the phone\'s workspace, and a receipt for another conversation is not taken', async () => {
    const storage = createMemoryStorage()
    await createMacSessionStore(storage).write({ kind: 'rerun-mac-phone-pairing', status: 'approved', credential: 'c'.repeat(43), origin: 'http://127.0.0.1:9', workspaceId: 1, deviceId: 'device' })
    const general = 'fmc_11111111-1111-4111-8111-111111111111'
    const thread = 'fmc_22222222-2222-4222-8222-222222222222'
    const requestId = '4ce8e801-9bbd-4c6e-8221-2e326471724c'
    const calls = []
    let answer = {}
    const client = createMacPairingClient({
        storage,
        fetch: async (url, init) => {
            calls.push({ url: url.slice('http://127.0.0.1:9/api/mac-pairing/v1'.length), method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) })
            return Response.json(answer)
        },
    })
    answer = { state: 'ready', conversations: [] }
    await client.readChief()
    await client.openChiefChat(general)
    answer = { requestId, chatId: thread }
    assert.equal(await client.sendToChief({ requestId, text: 'Plan it', thread: true }), thread)
    assert.deepEqual(calls.map(call => [call.method, call.url]), [['GET', '/workspaces/1/chief'], ['GET', `/workspaces/1/chief/chat?chat=${general}`], ['POST', '/workspaces/1/chief/send']])
    assert.deepEqual(calls[2].body, { requestId, text: 'Plan it', thread: true })
    assert(calls.every(call => call.auth === `Bearer ${'c'.repeat(43)}`))
    // A receipt that names another conversation, another request, or no conversation is not a send.
    for (const receipt of [{ requestId, chatId: thread }, { requestId: 'other', chatId: general }, { requestId, chatId: 'chat-1' }]) {
        answer = receipt
        await assert.rejects(client.sendToChief({ requestId, text: 'Hi', chatId: general }), /invalid_send_receipt/)
    }
    answer = { status: 'paused' }
    await assert.rejects(client.readChiefTurn(general, requestId), /invalid_turn_status/)
    answer = { requestId: 'other' }
    await assert.rejects(client.answerChief(general, { requestId, toolCallId: 'call-1', answers: [['Sales']] }), /invalid_send_receipt/)
    await assert.rejects(client.stopChiefTurn(general, requestId), /invalid_stop_receipt/)
})

test('a voice conversation is asked for on the phone\'s workspace, and a refusal keeps the Mac\'s code', async () => {
    const storage = createMemoryStorage()
    await createMacSessionStore(storage).write({ kind: 'rerun-mac-phone-pairing', status: 'approved', credential: 'c'.repeat(43), origin: 'http://127.0.0.1:9', workspaceId: 3, deviceId: 'device' })
    const chatId = 'fmc_11111111-1111-4111-8111-111111111111'
    const calls = []
    let reply = Response.json({ conversationToken: 'voice-token', conversationId: 'conv_1', expiresAt: '2026-11-17T12:00:00Z', extra: 'dropped' })
    const client = createMacPairingClient({
        storage,
        fetch: async (url, init) => {
            calls.push({ url: url.slice('http://127.0.0.1:9/api/mac-pairing/v1'.length), method: init.method, body: JSON.parse(init.body) })
            return reply
        },
    })
    assert.deepEqual(await client.startVoice(chatId), { conversationToken: 'voice-token', conversationId: 'conv_1', expiresAt: '2026-11-17T12:00:00Z' })
    assert.deepEqual(calls, [{ url: '/workspaces/3/voice/start', method: 'POST', body: { chatId } }])
    for (const [status, code] of [[404, 'not_found'], [503, 'unavailable'], [403, 'send_not_allowed'], [429, 'rate_limited']]) {
        reply = Response.json({ error: code }, { status })
        await assert.rejects(client.startVoice(chatId), error => error.message === code && error.status === status)
    }
    reply = Response.json({ conversationId: 'conv_1' })
    await assert.rejects(client.startVoice(chatId), /invalid_voice_session/)
})
