// What the phone app (apps/mobile) leans on beyond the pairing itself: how the Mac answers a phone it
// no longer accepts, a caller with no token, an address that is not on the local network, and the
// question or approval card of a saved chat.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMacPhonePairingService, PHONE_SESSION_KEY } from '../src/main/mac-phone-pairing/index.mjs'
import { isPrivateAddress, localPairingAddresses } from '../src/main/mac-phone-pairing/lan-identity.mjs'
import { seedLegacyCatalog } from '../src/main/workspaces/catalog.mjs'
import { createMacPairingClient, createMemoryStorage } from '../../../packages/mac-pairing-client/src/index.mjs'

const INSTALL_ID = '2f1c8a16-6d4a-4c3a-9b2e-0c1d9a7e4b11'
const SESSION_COOKIE = 'desktop-test-cookie'
const CHAT = { id: 'chat-saved-1', agentId: 'coworker-ada', title: 'Saved briefing', createdAt: '2026-11-12T18:00:00.000Z', updatedAt: '2026-11-12T18:05:00.000Z', kind: 'thread' }
const PENDING = {
    question: { toolCallId: 'call-question', questions: [{ question: 'Which color?', options: ['Red', 'Blue'], multiple: false }] },
    approval: { toolCallId: 'call-approval', approvals: [{ action: 'Send the report', detail: 'To the whole team' }] },
}

function json(response, status, body) {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
}

// Stands in for the Mac app's own /api/desktop/phone-pairing route, which only the pairing service calls.
async function workspaceFixture(t) {
    const seen = []
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1')
        seen.push(url.pathname + url.search)
        if (request.headers.cookie !== `rerun-desktop-session=${SESSION_COOKIE}`) return json(response, 401, { error: 'Unauthorized' })
        if (!url.searchParams.get('agentId')) return json(response, 200, { coworkers: [{ id: 'coworker-ada', name: 'Ada', status: 'enabled' }] })
        if (!url.searchParams.get('chatId')) return json(response, 200, { chats: [CHAT], acceptsMessages: true })
        return json(response, 200, { chat: { ...CHAT, acceptsMessages: true }, messages: [], pending: PENDING })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    t.after(() => new Promise(resolve => server.close(resolve)))
    return { origin: `http://127.0.0.1:${server.address().port}`, seen }
}

async function start(t) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-mac-phone-app-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await seedLegacyCatalog(root, INSTALL_ID)
    const workspace = await workspaceFixture(t)
    const runtime = { workspaceId: 1, app: { origin: workspace.origin, sessionToken: SESSION_COOKIE } }
    const service = createMacPhonePairingService({ dataRoot: root, installId: INSTALL_ID, getRuntime: () => runtime })
    t.after(() => service.stop())
    return { service, workspace }
}

async function pair(service) {
    const storage = createMemoryStorage()
    const client = createMacPairingClient({ storage, deviceName: 'Test iPhone' })
    const pending = await client.connectToThisMac(await service.createOffer(1))
    await service.approveDevice(pending.deviceId)
    assert.equal((await client.waitForApproval()).status, 'approved')
    return { client, storage, deviceId: pending.deviceId }
}

test('a removed phone is told it was removed, and nobody else is', async t => {
    const { service } = await start(t)
    await service.setPhoneAccessEnabled(true)
    const kept = await pair(service)
    const removed = await pair(service)
    await service.revokeDevice(removed.deviceId)

    await assert.rejects(() => removed.client.listCoworkers(), error => error.message === 'revoked' && error.status === 401)
    assert.equal((await kept.client.listCoworkers()).coworkers.length, 1)

    // A token the Mac never issued, and the removed phone's id without its token, learn nothing.
    const session = JSON.parse(removed.storage.snapshot()[PHONE_SESSION_KEY])
    const guess = createMacPairingClient({ storage: createMemoryStorage({ [PHONE_SESSION_KEY]: JSON.stringify({ ...session, credential: 'A'.repeat(43) }) }) })
    await assert.rejects(() => guess.listCoworkers(), error => error.message === 'unauthorized' && error.status === 401)
})

test('a request with no token, or a malformed one, reads nothing from the workspace', async t => {
    const { service, workspace } = await start(t)
    const { origin } = await service.setPhoneAccessEnabled(true)
    await pair(service)
    const path = origin + '/api/mac-pairing/v1/workspaces/1/coworkers'
    for (const headers of [{}, { Authorization: 'Bearer' }, { Authorization: 'Bearer short' }, { Authorization: 'Basic ' + 'A'.repeat(43) }, { Cookie: `rerun-desktop-session=${SESSION_COOKIE}` }]) {
        const response = await fetch(path, { headers })
        assert.equal(response.status, 401)
        assert.deepEqual(await response.json(), { error: 'unauthorized' })
    }
    assert.deepEqual(workspace.seen, [])
})

test('a page in a browser cannot use the phone listener', async t => {
    const { service } = await start(t)
    const { origin } = await service.setPhoneAccessEnabled(true)
    const { storage } = await pair(service)
    const { credential } = JSON.parse(storage.snapshot()[PHONE_SESSION_KEY])
    const response = await fetch(origin + '/api/mac-pairing/v1/workspaces/1/coworkers', { headers: { Authorization: `Bearer ${credential}`, Origin: 'https://example.com' } })
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('the listener only ever binds loopback or a private address of this Mac', async t => {
    const { service } = await start(t)
    await assert.rejects(() => service.setLanAddress('192.168.1.20'), error => error.code === 'disabled')
    await service.setPhoneAccessEnabled(true)
    for (const address of ['0.0.0.0', '8.8.8.8', '169.254.10.10', '100.100.1.1', 'example.com', '::', '192.168.1.20.evil.example']) {
        assert.equal(isPrivateAddress(address), false)
        await assert.rejects(() => service.setLanAddress(address), error => error.code === 'lan_address_unavailable')
    }
    // A private address this Mac does not hold is refused too.
    const foreign = ['10.253.254.1', '192.168.253.254'].find(address => !localPairingAddresses().includes(address))
    await assert.rejects(() => service.setLanAddress(foreign), error => error.code === 'lan_address_unavailable')
    const status = await service.status()
    assert.equal(status.bindHost, '127.0.0.1')
    assert.equal(status.lanBindingEnabled, false)
})

test('the phone refuses an offer that names an address outside the local network', async () => {
    const client = createMacPairingClient({ storage: createMemoryStorage(), fetch: () => assert.fail('nothing may be sent'), pinnedFetch: () => assert.fail('nothing may be sent') })
    const offer = { version: 1, kind: 'rerun-mac-phone-pairing', offerId: 'offer', workspaceId: 1, macId: 'mac', fingerprint: 'f'.repeat(64), secret: 'S'.repeat(43) }
    const pin = 'a'.repeat(64)
    for (const [origin, certificateFingerprint] of [
        ['https://203.0.113.9:4000', pin], ['https://mac.example.com:4000', pin], ['http://192.168.1.20:4000', undefined],
        ['http://192.168.1.20:4000', pin], ['https://192.168.1.20:4000', undefined], ['https://192.168.1.20', pin],
    ]) {
        await assert.rejects(() => client.connectToThisMac({ ...offer, origin, certificateFingerprint }), error => error.message === 'invalid_origin')
    }
})

test('a saved chat carries the question and the approval it waits on to an approved phone', async t => {
    const { service } = await start(t)
    await service.setPhoneAccessEnabled(true)
    const { client } = await pair(service)
    const chat = await client.openSavedChat('coworker-ada', CHAT.id)
    assert.deepEqual(chat.pending, PENDING)
    // A phone paired on this Mac only, with no certificate to pin, reads but never sends.
    assert.deepEqual(chat.permissions, { sendMessages: false })
})
