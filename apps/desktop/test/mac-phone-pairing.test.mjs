import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMacPhonePairingService, CUSTOM_SERVER_KEY, LOOPBACK_HOST, PHONE_SESSION_KEY } from '../src/main/mac-phone-pairing/index.mjs'
import { hashSecret } from '../src/main/mac-phone-pairing/crypto.mjs'
import { createWorkspace, seedLegacyCatalog } from '../src/main/workspaces/catalog.mjs'
import { createMacPairingClient, createMemoryStorage, startSignInEntries } from '../../../packages/mac-pairing-client/src/index.mjs'

const INSTALL_ID = '2f1c8a16-6d4a-4c3a-9b2e-0c1d9a7e4b11'
const SESSION_COOKIE = 'desktop-test-cookie'
const AGENT = { id: 'coworker-ada', name: 'Ada', status: 'idle' }
const CHAT = {
    id: 'chat-saved-1',
    agentId: 'coworker-ada',
    title: 'Saved briefing',
    status: 'open',
    createdAt: '2026-11-12T18:00:00.000Z',
    updatedAt: '2026-11-12T18:05:00.000Z',
}
const MESSAGE = {
    id: 'msg-1',
    role: 'user',
    createdAt: '2026-11-12T18:00:01.000Z',
    authorId: 'owner',
    authorName: 'George',
    content: { type: 'text', text: 'Hello from the Mac workspace' },
}

function clock(start = 1_000_000) {
    let current = start
    return { now: () => current, advance: ms => { current += ms } }
}

async function listen(handler, host = '127.0.0.1') {
    const server = createServer((request, response) => {
        Promise.resolve(handler(request, response)).catch(() => {
            response.writeHead(500)
            response.end()
        })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
    const address = server.address()
    return { server, origin: `http://${address.address}:${address.port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

function json(response, status, body) {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
}

async function startWorkspaceFixture(beforeRead = async () => {}) {
    return listen(async (request, response) => {
        if (request.headers.cookie !== `rerun-desktop-session=${SESSION_COOKIE}`) return json(response, 401, { error: 'Unauthorized' })
        const url = new URL(request.url, 'http://127.0.0.1')
        if (url.pathname !== '/api/desktop/phone-pairing') return json(response, 404, { error: 'not found' })
        await beforeRead()
        const agent = url.searchParams.get('agentId')
        const chat = url.searchParams.get('chatId')
        if (!agent && !chat) return json(response, 200, { coworkers: [AGENT] })
        if (agent !== AGENT.id) return json(response, 404, { error: 'not found' })
        if (!chat) return json(response, 200, { chats: [CHAT] })
        if (chat !== CHAT.id) return json(response, 404, { error: 'not found' })
        return json(response, 200, { chat: CHAT, messages: [MESSAGE] })
    })
}

async function dataRoot(t) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-mac-phone-pairing-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await seedLegacyCatalog(root, INSTALL_ID)
    return root
}

function createService(t, root, options = {}) {
    const time = options.time ?? clock()
    let runtime = {
        workspaceId: options.selectedWorkspaceId ?? 1,
        app: options.workspace ? { origin: options.workspace.origin, sessionToken: SESSION_COOKIE } : null,
    }
    const service = createMacPhonePairingService({
        dataRoot: root,
        installId: INSTALL_ID,
        getRuntime: () => runtime,
        now: time.now,
        offerTtlMs: options.offerTtlMs,
    })
    t.after(() => service.stop())
    return { service, time, setSelected: id => { runtime = { ...runtime, workspaceId: id } } }
}

async function pairedClient(service, storage = createMemoryStorage()) {
    const offer = await service.createOffer(1)
    const client = createMacPairingClient({ storage, deviceName: 'Test iPhone' })
    const pending = await client.connectToThisMac(offer)
    await service.approveDevice(pending.deviceId)
    const approved = await client.waitForApproval()
    assert.equal(approved.status, 'approved')
    assert.equal(typeof approved.credential, 'string')
    return { client, offer, pending, storage }
}

test('phone access and LAN stay off, and constructing the service does not listen', async t => {
    const root = await dataRoot(t)
    const { service } = createService(t, root)
    const status = await service.status()
    assert.equal(status.phoneAccessEnabled, false)
    assert.equal(status.lanBindingEnabled, false)
    assert.equal(status.lanOffByDefault, true)
    assert.equal(status.listening, false)
    assert.equal(status.bindHost, null)
    assert.equal(service.address(), null)
    await assert.rejects(() => service.createOffer(1), error => error.code === 'disabled')
    await assert.rejects(() => service.setLanBindingEnabled(true), error => error.code === 'lan_off')
})

test('enabling phone access starts a loopback transport and never enables LAN', async t => {
    const root = await dataRoot(t)
    const { service } = createService(t, root)
    const status = await service.setPhoneAccessEnabled(true)
    assert.equal(status.phoneAccessEnabled, true)
    assert.equal(status.lanBindingEnabled, false)
    assert.equal(status.listening, true)
    assert.equal(status.bindHost, LOOPBACK_HOST)
    assert.match(status.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    const settings = JSON.parse(await readFile(join(root, 'mac-phone-pairing', 'settings.json'), 'utf8'))
    assert.equal(settings.lanBindingEnabled, false)
    await service.stop()
})

test('pairing success lists coworkers and opens a saved chat through existing desktop workspace reads', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    const { client, storage } = await pairedClient(service)
    const coworkers = await client.listCoworkers()
    assert.deepEqual(coworkers, { coworkers: [{ id: AGENT.id, name: AGENT.name, status: AGENT.status }] })
    const chats = await client.listSavedChats(AGENT.id)
    assert.equal(chats.chats[0].id, CHAT.id)
    assert.equal(chats.chats[0].title, CHAT.title)
    const opened = await client.openSavedChat(AGENT.id, CHAT.id)
    assert.equal(opened.chat.id, CHAT.id)
    assert.equal(opened.messages[0].id, MESSAGE.id)
    assert.deepEqual(opened.messages[0].content, { type: 'text', text: 'Hello from the Mac workspace' })
    const stored = JSON.parse(await readFile(join(root, 'mac-phone-pairing', 'devices.json'), 'utf8'))
    const device = stored.devices[0]
    assert.equal(device.status, 'approved')
    assert.equal(typeof device.credentialHash, 'string')
    assert.equal(device.credentialHash, hashSecret((await client.readMacSession()).credential))
    assert.equal(JSON.stringify(stored).includes((await client.readMacSession()).credential), false)
    assert.equal(storage.snapshot()[PHONE_SESSION_KEY].includes((await client.readMacSession()).credential), true)
    await service.stop()
})

test('an expired offer is refused', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service, time } = createService(t, root, { workspace, offerTtlMs: 120_000 })
    await service.setPhoneAccessEnabled(true)
    const offer = await service.createOffer(1)
    time.advance(120_001)
    const client = createMacPairingClient({ storage: createMemoryStorage() })
    await assert.rejects(() => client.connectToThisMac(offer), error => error.message === 'invalid_offer' && error.status === 401)
    await service.stop()
})

test('a reused offer is refused', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    const offer = await service.createOffer(1)
    const first = createMacPairingClient({ storage: createMemoryStorage() })
    await first.connectToThisMac(offer)
    const second = createMacPairingClient({ storage: createMemoryStorage() })
    await assert.rejects(() => second.connectToThisMac(offer), error => error.message === 'invalid_offer')
    await service.stop()
})

test('a wrong pairing secret is refused', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    const offer = await service.createOffer(1)
    const client = createMacPairingClient({ storage: createMemoryStorage() })
    await assert.rejects(() => client.connectToThisMac({ ...offer, secret: 'totally-wrong-secret' }), error => error.message === 'invalid_offer')
    await service.stop()
})

test('an unapproved device cannot list coworkers or open a saved chat', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    const offer = await service.createOffer(1)
    const client = createMacPairingClient({ storage: createMemoryStorage() })
    await client.connectToThisMac(offer)
    const pending = await client.waitForApproval()
    assert.equal(pending.status, 'pending')
    await assert.rejects(() => client.listCoworkers(), error => error.message === 'not_paired')
    // Even a guessed pending token cannot read workspace data.
    const session = await client.readMacSession()
    session.credential = session.requestToken
    session.status = 'approved'
    await client.clearMacSession()
    const storage = createMemoryStorage({ [PHONE_SESSION_KEY]: JSON.stringify(session) })
    const intruder = createMacPairingClient({ storage })
    await assert.rejects(() => intruder.listCoworkers(), error => error.message === 'unauthorized' && error.status === 401)
    await service.stop()
})

test('a request for another workspace is refused without leaking that it exists', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    await createWorkspace(root, INSTALL_ID, { name: 'Private workspace', requestId: '9f1c8a16-6d4a-4c3a-9b2e-0c1d9a7e4b22' })
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    const { client } = await pairedClient(service)
    const session = await client.readMacSession()
    const other = await fetch(`${session.origin}/api/mac-pairing/v1/workspaces/2/coworkers`, {
        headers: { Authorization: `Bearer ${session.credential}`, Accept: 'application/json' },
    })
    const missing = await fetch(`${session.origin}/api/mac-pairing/v1/workspaces/99/coworkers`, {
        headers: { Authorization: `Bearer ${session.credential}`, Accept: 'application/json' },
    })
    assert.equal(other.status, 404)
    assert.equal(missing.status, 404)
    const otherBody = await other.json()
    const missingBody = await missing.json()
    assert.deepEqual(otherBody, { error: 'not_found' })
    assert.deepEqual(missingBody, { error: 'not_found' })
    assert.equal(JSON.stringify(otherBody).includes('Private workspace'), false)
    assert.equal(JSON.stringify(missingBody).includes('Private workspace'), false)
    await service.stop()
})

test('revocation takes effect immediately and still holds after a reload from disk', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const first = createService(t, root, { workspace })
    await first.service.setPhoneAccessEnabled(true)
    const { client, pending } = await pairedClient(first.service)
    assert.equal((await client.listCoworkers()).coworkers[0].id, AGENT.id)
    await first.service.revokeDevice(pending.deviceId)
    await assert.rejects(() => client.listCoworkers(), error => error.message === 'unauthorized')
    await first.service.stop()

    const second = createService(t, root, { workspace })
    const restored = await second.service.restore()
    assert.equal(restored.phoneAccessEnabled, true)
    assert.equal(restored.listening, true)
    assert.equal(restored.devices[0].status, 'revoked')
    await assert.rejects(() => client.listCoworkers(), error => error.message === 'unauthorized')
    await second.service.stop()
})

for (const change of ['revocation', 'workspace restart']) {
    test(`a read that overlaps ${change} releases no workspace data`, async t => {
        const root = await dataRoot(t)
        const entered = Promise.withResolvers()
        const resume = Promise.withResolvers()
        const workspace = await startWorkspaceFixture(async () => {
            entered.resolve()
            await resume.promise
        })
        t.after(workspace.close)
        const { service, setSelected } = createService(t, root, { workspace })
        await service.setPhoneAccessEnabled(true)
        const { client, pending } = await pairedClient(service)
        const read = client.listCoworkers()
        const refused = assert.rejects(read, error => error.status === (change === 'revocation' ? 401 : 404))
        try {
            await entered.promise
            if (change === 'revocation') await service.revokeDevice(pending.deviceId)
            else setSelected(1) // same workspace ID with a different running instance
        } finally {
            resume.resolve()
        }
        await refused
        if (change === 'revocation') {
            assert.equal((await service.devices())[0].status, 'revoked')
            await assert.rejects(client.listCoworkers(), error => error.status === 401)
        }
    })
}

test('disabling local pairing closes the listener and invalidates unused offers', async t => {
    const root = await dataRoot(t)
    const { service } = createService(t, root)
    await service.setPhoneAccessEnabled(true)
    const offer = await service.createOffer()
    const browser = await fetch(`${offer.origin}/api/mac-pairing/v1/meta`, { headers: { Origin: 'https://example.test' } })
    assert.equal(browser.status, 404)
    assert.equal(browser.headers.get('access-control-allow-origin'), null)
    const [off, on] = await Promise.all([service.setPhoneAccessEnabled(false), service.setPhoneAccessEnabled(true)])
    assert.equal(off.listening, false)
    assert.equal(on.listening, true)
    const client = createMacPairingClient({ storage: createMemoryStorage() })
    await assert.rejects(client.connectToThisMac(offer), error => error.status === 401)
})

test('approved pairings persist across a Mac restart and keep working', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const first = createService(t, root, { workspace })
    await first.service.setPhoneAccessEnabled(true)
    const { client } = await pairedClient(first.service)
    await first.service.stop()
    const second = createService(t, root, { workspace })
    await second.service.restore()
    const coworkers = await client.listCoworkers()
    assert.equal(coworkers.coworkers[0].name, 'Ada')
    const opened = await client.openSavedChat(AGENT.id, CHAT.id)
    assert.equal(opened.chat.title, 'Saved briefing')
    await second.service.stop()
})

test('the phone keeps a Mac-paired session separate from cloud and self-hosted sessions', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    const cloud = { apiUrl: 'https://app.rerun.build', supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_cloud' }
    const storage = createMemoryStorage({
        [CUSTOM_SERVER_KEY]: JSON.stringify(cloud),
        'sb-example-auth-token': '{"access_token":"cloud-jwt"}',
        'rerun.workspace-id': '12',
    })
    const { client } = await pairedClient(service, storage)
    const snapshot = storage.snapshot()
    assert.equal(snapshot[CUSTOM_SERVER_KEY], JSON.stringify(cloud))
    assert.equal(snapshot['sb-example-auth-token'], '{"access_token":"cloud-jwt"}')
    assert.equal(snapshot['rerun.workspace-id'], '12')
    assert.equal(typeof snapshot[PHONE_SESSION_KEY], 'string')
    assert.notEqual(snapshot[PHONE_SESSION_KEY], snapshot[CUSTOM_SERVER_KEY])
    const entries = startSignInEntries()
    assert.deepEqual(entries.map(entry => entry.id), ['cloud', 'own-server', 'this-mac'])
    assert.equal(entries.find(entry => entry.id === 'own-server').label, 'Use your own server')
    assert.equal(entries.find(entry => entry.id === 'this-mac').label, 'Connect to This Mac')
    await service.stop()
})
