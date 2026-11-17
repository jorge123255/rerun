// A paired phone asking the Mac for a voice conversation with the Chief of Staff: the phone listener
// serves it as one of its named resources, to a phone that may send messages, a few times a minute.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMacPhonePairingService } from '../src/main/mac-phone-pairing/index.mjs'
import { localPairingAddresses } from '../src/main/mac-phone-pairing/lan-identity.mjs'
import { seedLegacyCatalog } from '../src/main/workspaces/catalog.mjs'
import { createMacPairingClient, createMemoryStorage } from '../../../packages/mac-pairing-client/src/index.mjs'
import { pinnedFetch } from './mac-phone-pairing-client-fixture.mjs'

const INSTALL_ID = '2f1c8a16-6d4a-4c3a-9b2e-0c1d9a7e4b12'
const SESSION_COOKIE = 'desktop-voice-test-cookie'
const GRANT = { conversationToken: 'webrtc-token-1', conversationId: 'conv_abc123', expiresAt: '2026-11-17T12:05:00.000Z' }

function json(response, status, body) {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
}

// Stands in for the Mac app's /api/desktop/phone-pairing/voice/start route.
async function appFixture(t) {
    const calls = []
    const state = { status: 200 }
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1')
        if (request.headers.cookie !== `rerun-desktop-session=${SESSION_COOKIE}`) return json(response, 401, { error: 'Unauthorized' })
        if (url.pathname !== '/api/desktop/phone-pairing/voice/start' || request.method !== 'POST') return json(response, 404, { error: 'not found' })
        const chunks = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => {
            calls.push(JSON.parse(Buffer.concat(chunks)))
            if (state.status !== 200) return json(response, state.status, { error: 'The app says something about itself here.', code: 'voice_unavailable' })
            json(response, 200, GRANT)
        })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    t.after(() => new Promise(resolve => server.close(resolve)))
    return { origin: `http://127.0.0.1:${server.address().port}`, calls, state }
}

test('a voice conversation is given only to an approved phone that may send, and only a few a minute', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const root = await mkdtemp(join(tmpdir(), 'rerun-mac-phone-voice-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await seedLegacyCatalog(root, INSTALL_ID)
    const app = await appFixture(t)
    let clock = Date.parse('2026-11-17T12:00:00.000Z')
    const runtime = { workspaceId: 1, app: { origin: app.origin, sessionToken: SESSION_COOKIE } }
    const service = createMacPhonePairingService({ dataRoot: root, installId: INSTALL_ID, getRuntime: () => runtime, now: () => clock })
    t.after(() => service.stop())
    await service.setPhoneAccessEnabled(true)
    const { origin } = await service.setLanAddress(host)
    const offer = await service.createOffer(1)
    const voice = origin + '/api/mac-pairing/v1/workspaces/1/voice/start'
    const ask = (headers = {}, body = JSON.stringify({ chatId: 'fmc_conversation1' })) =>
        pinnedFetch(voice, offer.certificateFingerprint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })

    // Nobody without a token, and an unpaired phone, reach nothing.
    assert.equal((await ask()).status, 401)
    assert.equal((await ask({ Authorization: `Bearer ${'A'.repeat(43)}` })).status, 401)
    assert.deepEqual(app.calls, [])

    const client = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch, deviceName: 'Test iPhone' })
    const pending = await client.connectToThisMac(offer)
    await service.approveDevice(pending.deviceId)
    assert.equal((await client.waitForApproval()).status, 'approved')
    const { credential } = await client.readMacSession()
    const auth = { Authorization: `Bearer ${credential}` }

    // Approved, but not allowed to send.
    const refused = await ask(auth)
    assert.equal(refused.status, 403)
    assert.deepEqual(await refused.json(), { error: 'send_not_allowed' })
    assert.deepEqual(app.calls, [])

    await service.setSendMessages(pending.deviceId, true)
    const granted = await ask(auth)
    assert.equal(granted.status, 200)
    assert.deepEqual(await granted.json(), GRANT)
    assert.deepEqual(app.calls, [{ chatId: 'fmc_conversation1' }])

    // The feature off on the Mac does not exist for the phone; a relay that is down is unavailable,
    // and nothing the app says about itself is passed on.
    app.state.status = 404
    const hidden = await ask(auth)
    assert.equal(hidden.status, 404)
    assert.deepEqual(await hidden.json(), { error: 'not_found' })
    app.state.status = 503
    const down = await ask(auth)
    assert.equal(down.status, 502)
    assert.deepEqual(await down.json(), { error: 'unavailable' })

    // Three a minute per phone.
    app.state.status = 200
    const limited = await ask(auth)
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json(), { error: 'rate_limited' })
    assert.equal(app.calls.length, 3)
    clock += 61_000
    assert.equal((await ask(auth)).status, 200)

    // A malformed body is refused before the app is asked; another workspace does not exist.
    clock += 61_000
    assert.equal((await ask(auth, 'not json')).status, 400)
    assert.equal((await pinnedFetch(origin + '/api/mac-pairing/v1/workspaces/2/voice/start', offer.certificateFingerprint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' })).status, 404)
    assert.equal((await pinnedFetch(origin + '/api/mac-pairing/v1/workspaces/1/voice/start', offer.certificateFingerprint, { method: 'GET', headers: auth })).status, 404)

    // A removed phone is told so.
    const before = app.calls.length
    await service.revokeDevice(pending.deviceId)
    const revoked = await ask(auth)
    assert.equal(revoked.status, 401)
    assert.deepEqual(await revoked.json(), { error: 'revoked' })
    assert.equal(app.calls.length, before)
})
