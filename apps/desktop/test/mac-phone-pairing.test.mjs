import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMacPhonePairingService, CUSTOM_SERVER_KEY, LOOPBACK_HOST, PHONE_SESSION_KEY } from '../src/main/mac-phone-pairing/index.mjs'
import { CREDENTIAL_CLAIM_TTL_MS } from '../src/main/mac-phone-pairing/protocol.mjs'
import { hashSecret } from '../src/main/mac-phone-pairing/crypto.mjs'
import { localPairingAddresses } from '../src/main/mac-phone-pairing/lan-identity.mjs'
import { createWorkspace, renameWorkspace, seedLegacyCatalog } from '../src/main/workspaces/catalog.mjs'
import { createMacPairingClient, createMemoryStorage, startSignInEntries } from '../../../packages/mac-pairing-client/src/index.mjs'
import { pinnedFetch } from './mac-phone-pairing-client-fixture.mjs'

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

async function startWorkspaceFixture(beforeRead = async () => {}, onSend, onStream, onStop) {
    return listen(async (request, response) => {
        if (request.headers.cookie !== `rerun-desktop-session=${SESSION_COOKIE}`) return json(response, 401, { error: 'Unauthorized' })
        const url = new URL(request.url, 'http://127.0.0.1')
        if (url.pathname !== '/api/desktop/phone-pairing') return json(response, 404, { error: 'not found' })
        await beforeRead()
        const agent = url.searchParams.get('agentId')
        const chat = url.searchParams.get('chatId')
        if (!agent && !chat) return json(response, 200, { coworkers: [AGENT] })
        if (agent !== AGENT.id) return json(response, 404, { error: 'not found' })
        if (!chat && request.method === 'GET') return json(response, 200, { chats: [CHAT], acceptsMessages: true })
        if (chat && chat !== CHAT.id) return json(response, 404, { error: 'not found' })
        if (request.method === 'POST' && onSend) {
            assert.equal(request.headers.origin, 'http://' + request.headers.host)
            const chunks = []
            for await (const chunk of request) chunks.push(chunk)
            const input = JSON.parse(Buffer.concat(chunks))
            onSend(input)
            return json(response, 202, { runId: input.runId, ...(input.chatId && { chatId: input.chatId }) })
        }
        if (request.method === 'DELETE' && onStop) {
            assert.equal(request.headers.origin, 'http://' + request.headers.host)
            const runId = url.searchParams.get('runId')
            return onStop(runId) ? json(response, 200, { runId }) : json(response, 404, { error: 'not found' })
        }
        if (url.searchParams.get('stream') === '1' && onStream) return onStream(response)
        if (url.searchParams.has('runId')) return json(response, 200, { status: 'done' })
        return json(response, 200, { chat: { ...CHAT, acceptsMessages: true }, messages: [MESSAGE] })
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
    await assert.rejects(() => service.setLanAddress('192.168.1.2'), error => error.code === 'disabled')
})

test('pairing status labels phones with their own workspace name as the active workspace changes', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service, setSelected } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    const second = await createWorkspace(root, INSTALL_ID, {
        name: 'Second workspace',
        requestId: '9f1c8a16-6d4a-4c3a-9b2e-0c1d9a7e4b22',
    })
    assert.equal(second.ok, true)
    const { client, pending } = await pairedClient(service)
    const staleOffer = await service.createOffer(1)
    const otherPhone = createMacPairingClient({ storage: createMemoryStorage(), deviceName: 'Pending phone' })
    const waiting = await otherPhone.connectToThisMac(staleOffer)
    const renamed = await renameWorkspace(root, INSTALL_ID, {
        workspaceId: 1,
        name: 'Renamed workspace',
        requestId: '9f1c8a16-6d4a-4c3a-9b2e-0c1d9a7e4b23',
    })
    assert.equal(renamed.ok, true)
    const status = await service.status()
    assert.equal(status.selectedWorkspaceName, 'Renamed workspace')
    assert.equal(status.devices.find(device => device.deviceId === waiting.deviceId).workspaceName, 'Renamed workspace')
    assert.equal('workspaceName' in staleOffer, false)
    assert.equal('workspaceName' in await client.readMacSession(), false)

    setSelected(second.workspace.workspaceId)
    const switched = await service.status()
    assert.equal(switched.selectedWorkspaceName, 'Second workspace')
    assert.deepEqual(switched.devices.map(({ deviceId, workspaceName }) => [deviceId, workspaceName]),
        [[pending.deviceId, 'Renamed workspace']])
    await assert.rejects(() => service.createOffer(status.selectedWorkspaceId), { code: 'workspace_not_active' })
    assert.equal((await service.createOffer(switched.selectedWorkspaceId)).workspaceId, second.workspace.workspaceId)
})

test('declining a pending request persists and cannot revoke an already approved phone', async t => {
    const root = await dataRoot(t)
    const { service, setSelected } = createService(t, root)
    await service.setPhoneAccessEnabled(true)
    const { pending: approved } = await pairedClient(service)
    await assert.rejects(() => service.declineDevice(approved.deviceId), { code: 'not_found' })
    const phone = createMacPairingClient({ storage: createMemoryStorage() })
    const pending = await phone.connectToThisMac(await service.createOffer(1))
    setSelected(2)
    await assert.rejects(() => service.declineDevice(pending.deviceId), { code: 'not_found' })
    setSelected(1)
    await service.declineDevice(pending.deviceId)
    assert.deepEqual(await phone.waitForApproval(), { status: 'revoked' })
    await assert.rejects(() => service.approveDevice(pending.deviceId), { code: 'not_found' })
    await service.stop()
    const reopened = createService(t, root).service
    await reopened.restore()
    assert.deepEqual(await phone.waitForApproval(), { status: 'revoked' })
    assert.equal((await reopened.status()).devices.find(device => device.deviceId === approved.deviceId).status, 'approved')
})

test('the Mac distinguishes approval from credential collection, including after restart', async t => {
    const root = await dataRoot(t)
    const { service } = createService(t, root)
    await service.setPhoneAccessEnabled(true)
    const { pending: paired } = await pairedClient(service)
    const otherPhone = createMacPairingClient({ storage: createMemoryStorage() })
    const waiting = await otherPhone.connectToThisMac(await service.createOffer(1))
    await service.approveDevice(waiting.deviceId)
    const state = async (service, id) => (await service.status()).devices.find(device => device.deviceId === id).pairingState
    assert.equal(await state(service, waiting.deviceId), 'awaiting_phone')
    assert.equal(await state(service, paired.deviceId), 'paired')
    await service.stop()
    const reopened = createService(t, root).service
    await reopened.restore()
    assert.equal(await state(reopened, waiting.deviceId), 'incomplete')
    assert.equal(await state(reopened, paired.deviceId), 'paired')
    assert.deepEqual(await otherPhone.waitForApproval(), { status: 'revoked' })
    const retry = await otherPhone.connectToThisMac(await reopened.createOffer(1))
    await reopened.approveDevice(retry.deviceId)
    assert.equal((await otherPhone.waitForApproval()).status, 'approved')
    assert.equal(await state(reopened, retry.deviceId), 'paired')
})

test('expired approval requests stop appearing in the Mac pairing status', async t => {
    const root = await dataRoot(t)
    const { service, time } = createService(t, root)
    await service.setPhoneAccessEnabled(true)
    const phone = createMacPairingClient({ storage: createMemoryStorage() })
    const pending = await phone.connectToThisMac(await service.createOffer(1))
    assert.equal((await service.status()).devices[0].status, 'pending')
    time.advance(CREDENTIAL_CLAIM_TTL_MS)
    assert.deepEqual((await service.status()).devices, [])
    assert.deepEqual(await phone.waitForApproval(), { status: 'revoked' })
    await assert.rejects(() => service.approveDevice(pending.deviceId), { code: 'not_found' })
})

test('revoking a device while a reply is streaming withholds subsequent text', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const root = await dataRoot(t)
    const release = Promise.withResolvers()
    const workspace = await startWorkspaceFixture(undefined, undefined, async response => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        response.write('{"delta":"First visible part"}\n')
        await release.promise
        response.end('{"delta":"After revocation"}\n')
    })
    t.after(() => { release.resolve(); return workspace.close() })
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    await service.setLanAddress(host)
    const client = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch })
    const offer = await service.createOffer(1)
    const pending = await client.connectToThisMac(offer)
    await service.approveDevice(pending.deviceId)
    await client.waitForApproval()
    const session = await client.readMacSession()
    const url = session.origin + '/api/mac-pairing/v1/workspaces/1/coworkers/' + AGENT.id + '/chats/' + CHAT.id + '/turns/b4e687b7-e978-4411-a3bb-7d49c0486c11/stream'
    let received = ''
    const response = await pinnedFetch(url, session.certificateFingerprint, {
        headers: { Authorization: 'Bearer ' + session.credential },
        signal: AbortSignal.timeout(5000),
        async onChunk(chunk) {
            const first = !received
            received += chunk.toString()
            if (!first) return
            await service.revokeDevice(pending.deviceId)
            release.resolve()
        },
    })
    assert.equal(response.status, 200)
    assert.equal(received, '{"delta":"First visible part"}\n')
    assert.equal((await pinnedFetch(url, session.certificateFingerprint, {
        headers: { Authorization: 'Bearer ' + session.credential }, signal: AbortSignal.timeout(5000),
    })).status, 401)
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
    await assert.rejects(() => service.setLanAddress('0.0.0.0'), error => error.code === 'lan_address_unavailable')
    await assert.rejects(() => service.setLanAddress('127.0.0.1'), error => error.code === 'lan_address_unavailable')
    assert.equal(service.origin(), status.origin)
    await service.stop()
})

test('retry restores the saved endpoint and its approved device after a port conflict', async t => {
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    const { origin } = await service.setPhoneAccessEnabled(true)
    const { client } = await pairedClient(service)
    await service.stop()

    const blocker = createServer()
    const port = Number(new URL(origin).port)
    await new Promise((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(port, LOOPBACK_HOST, resolve)
    })
    t.after(() => { if (blocker.listening) blocker.close() })

    const { service: reopened } = createService(t, root, { workspace })
    await assert.rejects(() => reopened.restore(), { code: 'EADDRINUSE' })
    const status = await reopened.status()
    assert.equal(status.phoneAccessEnabled, true)
    assert.equal(status.listening, false)
    assert.equal(status.origin, null)
    assert.equal(status.devices[0].pairingState, 'paired')
    assert.equal((await reopened.settings()).loopbackPort, port)

    await new Promise((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()))
    assert.equal((await reopened.restore()).origin, origin)
    assert.equal((await client.listCoworkers()).coworkers[0].name, AGENT.name)
    await reopened.setPhoneAccessEnabled(false)
    assert.equal((await reopened.restore()).listening, false)
})

test('private-network pairing pins TLS and scopes approvals through restart and revocation', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const root = await dataRoot(t)
    const workspace = await startWorkspaceFixture()
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    const loopback = await service.setPhoneAccessEnabled(true)
    const oldPhone = await pairedClient(service)
    const oldOffer = await service.createOffer(1)
    const lan = await service.setLanAddress(host)
    assert.equal(lan.bindHost, host)
    assert.match(lan.origin, /^https:\/\//)
    await assert.rejects(fetch(loopback.origin))
    await assert.rejects(fetch(lan.origin.replace('https:', 'http:')))
    const offer = await service.createOffer(1)
    assert.match(offer.certificateFingerprint, /^[0-9a-f]{64}$/)
    const { mode } = await stat(join(root, 'mac-phone-pairing', `lan-${host}.json`))
    assert.equal(mode & 0o777, 0o600)
    const abort = AbortSignal.timeout(5000)
    assert.equal((await pinnedFetch(lan.origin + '/api/mac-pairing/v1/meta', offer.certificateFingerprint, { signal: abort })).status, 404)
    const coworkers = lan.origin + '/api/mac-pairing/v1/workspaces/1/coworkers'
    assert.equal((await pinnedFetch(coworkers, offer.certificateFingerprint, {
        signal: abort, headers: { Authorization: `Bearer ${(await oldPhone.client.readMacSession()).credential}` },
    })).status, 401)
    const storage = createMemoryStorage()
    const client = createMacPairingClient({ storage, pinnedFetch })
    await assert.rejects(() => client.connectToThisMac({ ...oldOffer, origin: lan.origin, certificateFingerprint: offer.certificateFingerprint }), /invalid_offer/)
    const forgedPin = '0'.repeat(64)
    await assert.rejects(() => client.connectToThisMac({ ...offer, certificateFingerprint: forgedPin }), /untrusted_mac/)
    assert.equal(await client.readMacSession(), null)
    const pending = await client.connectToThisMac(client.encodeOfferLink(offer))
    await service.approveDevice(pending.deviceId)
    await client.waitForApproval()
    const session = await client.readMacSession()
    assert.equal(session.certificateFingerprint, offer.certificateFingerprint)
    assert.equal((await client.openSavedChat(AGENT.id, CHAT.id)).messages[0].content.text, 'Hello from the Mac workspace')
    await service.stop()

    const { service: reopened } = createService(t, root, { workspace })
    assert.equal((await reopened.restore()).origin, lan.origin)
    assert.equal((await client.listCoworkers()).coworkers[0].name, AGENT.name)
    const local = await reopened.setLanAddress(null)
    const wrongTransport = await fetch(local.origin + '/api/mac-pairing/v1/workspaces/1/coworkers', {
        headers: { Authorization: `Bearer ${session.credential}` },
    })
    assert.equal(wrongTransport.status, 401)
    await reopened.revokeDevice(pending.deviceId)
    const enabledAgain = await reopened.setLanAddress(host)
    assert.equal((await pinnedFetch(enabledAgain.origin + '/api/mac-pairing/v1/workspaces/1/coworkers', session.certificateFingerprint, {
        signal: abort, headers: { Authorization: `Bearer ${session.credential}` },
    })).status, 401)
    await reopened.setPhoneAccessEnabled(false)
    const { service: disabled } = createService(t, root, { workspace })
    const restored = await disabled.restore()
    assert.equal(restored.phoneAccessEnabled, false)
    assert.equal(restored.lanBindingEnabled, false)
    assert.equal(restored.listening, false)
})

test('only the granted HTTPS device can send and stop its own turns, with stable per-device receipts', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const root = await dataRoot(t)
    const submissions = []
    const stopped = []
    const workspace = await startWorkspaceFixture(undefined, body => submissions.push(body), undefined, runId => {
        if (!submissions.some(message => message.runId === runId)) return false
        stopped.push(runId)
        return true
    })
    t.after(workspace.close)
    const { service } = createService(t, root, { workspace })
    await service.setPhoneAccessEnabled(true)
    await service.setLanAddress(host)
    const pair = async () => {
        const client = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch })
        const pending = await client.connectToThisMac(await service.createOffer(1))
        await service.approveDevice(pending.deviceId)
        await client.waitForApproval()
        return { client, deviceId: pending.deviceId }
    }
    const { client, deviceId } = await pair()
    const other = await pair()
    const message = { requestId: 'b4e687b7-e978-4411-a3bb-7d49c0486c11', text: 'Phone fixture message' }
    const send = () => client.sendMessage(AGENT.id, CHAT.id, message)
    const stop = () => client.stopSentTurn(AGENT.id, CHAT.id, message.requestId)
    assert.equal((await client.openSavedChat(AGENT.id, CHAT.id)).permissions.sendMessages, false)
    await assert.rejects(send, { status: 403 })
    await assert.rejects(stop, { status: 403 })
    assert.equal(submissions.length, 0)
    await service.setSendMessages(deviceId, true)
    assert.equal((await client.openSavedChat(AGENT.id, CHAT.id)).permissions.sendMessages, true)
    assert.equal((await send()).requestId, message.requestId)
    assert.equal((await send()).requestId, message.requestId)
    assert.deepEqual(submissions[0], submissions[1])
    assert.equal(submissions[0].text, message.text)
    assert.notEqual(submissions[0].runId, message.requestId)
    assert.equal((await client.readSentTurn(AGENT.id, CHAT.id, message.requestId)).status, 'done')
    await assert.rejects(() => other.client.sendMessage(AGENT.id, CHAT.id, message), { status: 403 })
    await assert.rejects(() => client.sendMessage(AGENT.id, 'foreign-chat', message), { status: 404 })
    await service.setSendMessages(other.deviceId, true)
    await assert.rejects(() => other.client.stopSentTurn(AGENT.id, CHAT.id, message.requestId), { status: 404 })
    await assert.rejects(() => client.stopSentTurn(AGENT.id, 'foreign-chat', message.requestId), { status: 404 })
    await stop()
    assert.deepEqual(stopped, [submissions[0].runId])
    await service.stop()
    const { service: restarted } = createService(t, root, { workspace })
    await restarted.restore()
    assert.equal((await client.openSavedChat(AGENT.id, CHAT.id)).permissions.sendMessages, true)
    assert.equal((await send()).requestId, message.requestId)
    assert.deepEqual(submissions[0], submissions[2])
    await restarted.setSendMessages(deviceId, false)
    await assert.rejects(send, { status: 403 })
    await assert.rejects(stop, { status: 403 })
    await restarted.revokeDevice(deviceId)
    await assert.rejects(send, { status: 401 })
    await assert.rejects(stop, { status: 401 })
    assert.deepEqual(stopped, [submissions[0].runId])
    assert.equal(submissions.length, 3)
    await assert.rejects(() => client.startConversation(AGENT.id, message), { status: 401 })
    const otherStart = () => other.client.startConversation(AGENT.id, message)
    assert.equal((await other.client.listSavedChats(AGENT.id)).permissions.sendMessages, true)
    const chatId = await otherStart()
    assert.equal(await otherStart(), chatId)
    assert.equal(submissions[3].chatId, chatId)
    assert.deepEqual(submissions[3], submissions[4])
    await restarted.setSendMessages(other.deviceId, false)
    assert.equal((await other.client.listSavedChats(AGENT.id)).permissions.sendMessages, false)
    await assert.rejects(otherStart, { status: 403 })
    assert.equal(submissions.length, 5)
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
