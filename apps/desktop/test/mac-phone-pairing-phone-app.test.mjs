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
import { isPrivateAddress, isTailscaleAddress, localPairingAddresses } from '../src/main/mac-phone-pairing/lan-identity.mjs'
import { seedLegacyCatalog } from '../src/main/workspaces/catalog.mjs'
import { createMacPairingClient, createMemoryStorage } from '../../../packages/mac-pairing-client/src/index.mjs'
import { pinnedFetch } from './mac-phone-pairing-client-fixture.mjs'

const INSTALL_ID = '2f1c8a16-6d4a-4c3a-9b2e-0c1d9a7e4b11'
const SESSION_COOKIE = 'desktop-test-cookie'
const CHAT = { id: 'chat-saved-1', agentId: 'coworker-ada', title: 'Saved briefing', createdAt: '2026-11-12T18:00:00.000Z', updatedAt: '2026-11-12T18:05:00.000Z', kind: 'thread' }
const INBOX = { items: [{ id: 'p:q1', state: 'question', agentId: 'coworker-ada', agentName: 'Ada', sessionId: 'chat-saved-1', sessionIds: ['chat-saved-1'], title: 'Saved briefing', message: 'Which color?', updatedAt: '2026-11-12T18:05:00.000Z', count: 1 }], partial: false }
const PENDING = {
    question: { toolCallId: 'call-question', questions: [{ question: 'Which color?', options: ['Red', 'Blue'], multiple: false }] },
    approval: { toolCallId: 'call-approval', approvals: [{ action: 'Send the report', detail: 'To the whole team' }] },
}

function json(response, status, body) {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
}

const CHIEF_GENERAL = 'fmc_11111111-1111-4111-8111-111111111111'
const CHIEF_THREAD = 'fmc_22222222-2222-4222-8222-222222222222'
const CHIEF = { state: 'ready', conversations: [{ id: CHIEF_GENERAL, title: null, kind: 'general', createdAt: '2026-11-12T18:00:00.000Z', updatedAt: '2026-11-12T18:05:00.000Z' }] }
const CHIEF_CHAT = {
    state: 'ready', chat: CHIEF.conversations[0], messages: [{ id: 'm1', role: 'assistant', content: { type: 'text', text: 'Here is a plan.' } }], running: false,
    pending: { question: { toolCallId: 'call-chief', questions: [{ question: 'Which team?', options: ['Sales', 'Support'], multiple: false }] }, approval: null, macOnly: null },
    cards: [{ kind: 'plan', title: 'Support desk', lines: ['Ava: answers tickets'] }],
}

// Stands in for the Mac app's Chief of Staff routes under /api/desktop/phone-pairing/chief.
function chiefFixture(url, request, response, posts) {
    const name = url.pathname.slice('/api/desktop/phone-pairing/'.length)
    if (request.method === 'GET') {
        if (name === 'chief') return json(response, 200, CHIEF)
        if (name === 'chief/chat') return json(response, 200, CHIEF_CHAT)
        if (name === 'chief/turn') return json(response, 200, { status: 'running' })
        if (name === 'chief/stream') {
            response.writeHead(200, { 'content-type': 'application/x-ndjson' })
            return response.end('{"reset":true}\n{"delta":"Working on it"}\n')
        }
        return json(response, 404, { error: 'not found' })
    }
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
        const input = JSON.parse(Buffer.concat(chunks))
        posts.push({ to: name, ...input })
        if (name === 'chief/send') return json(response, 200, { runId: input.runId, chatId: input.chatId ?? (input.newChatRequestId ? `fmc_${input.newChatRequestId}` : CHIEF_GENERAL) })
        if (name === 'chief/answer' || name === 'chief/stop') return json(response, 200, { runId: input.runId })
        json(response, 404, { error: 'not found' })
    })
}

// Stands in for the Mac app's own /api/desktop/phone-pairing route, which only the pairing service calls.
async function workspaceFixture(t) {
    const seen = []
    const posts = []
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1')
        seen.push(url.pathname + url.search)
        if (request.headers.cookie !== `rerun-desktop-session=${SESSION_COOKIE}`) return json(response, 401, { error: 'Unauthorized' })
        if (url.pathname === '/api/desktop/phone-pairing/inbox' && request.method === 'GET') return json(response, 200, INBOX)
        if (url.pathname.startsWith('/api/desktop/phone-pairing/chief')) return chiefFixture(url, request, response, posts)
        if (url.pathname !== '/api/desktop/phone-pairing' && url.pathname !== '/api/desktop/phone-pairing/inbox') return json(response, 404, { error: 'not found' })
        if (request.method === 'POST') {
            const chunks = []
            request.on('data', chunk => chunks.push(chunk))
            return request.on('end', () => {
                const input = JSON.parse(Buffer.concat(chunks))
                posts.push(input)
                json(response, 202, { runId: input.runId })
            })
        }
        if (!url.searchParams.get('agentId')) return json(response, 200, { coworkers: [{ id: 'coworker-ada', name: 'Ada', status: 'enabled' }] })
        if (!url.searchParams.get('chatId')) return json(response, 200, { chats: [CHAT], acceptsMessages: true })
        return json(response, 200, { chat: { ...CHAT, acceptsMessages: true }, messages: [], pending: PENDING })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    t.after(() => new Promise(resolve => server.close(resolve)))
    return { origin: `http://127.0.0.1:${server.address().port}`, seen, posts }
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
    for (const address of ['0.0.0.0', '8.8.8.8', '169.254.10.10', '100.63.255.255', '100.128.0.1', 'example.com', '::', '192.168.1.20.evil.example']) {
        assert.equal(isPrivateAddress(address), false)
        await assert.rejects(() => service.setLanAddress(address), error => error.code === 'lan_address_unavailable')
    }
    // A Tailscale address (100.64.0.0/10) counts as private, and one this Mac does not hold is refused like any other.
    for (const address of ['100.64.0.1', '100.100.1.1', '100.127.255.254']) {
        assert.equal(isPrivateAddress(address), true)
        assert.equal(isTailscaleAddress(address), true)
        if (!localPairingAddresses().includes(address)) await assert.rejects(() => service.setLanAddress(address), error => error.code === 'lan_address_unavailable')
    }
    assert.equal(isTailscaleAddress('192.168.1.20'), false)
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
    // Just outside Tailscale's range is the open internet as far as the phone is concerned.
    for (const origin of ['https://100.63.255.255:4000', 'https://100.128.0.1:4000']) {
        await assert.rejects(() => client.connectToThisMac({ ...offer, origin, certificateFingerprint: pin }), error => error.message === 'invalid_origin')
    }
})

test('the phone accepts a pinned offer on a Tailscale address', async () => {
    const seen = []
    const client = createMacPairingClient({ storage: createMemoryStorage(), fetch: () => assert.fail('a pinned offer never uses plain fetch'),
        pinnedFetch: async (url, init) => { seen.push([String(url), init?.certificateFingerprint ?? init?.fingerprint ?? null]); throw new Error('stop here') } })
    const offer = { version: 1, kind: 'rerun-mac-phone-pairing', offerId: 'offer', workspaceId: 1, macId: 'mac', fingerprint: 'f'.repeat(64), secret: 'S'.repeat(43) }
    await assert.rejects(() => client.connectToThisMac({ ...offer, origin: 'https://100.78.1.2:4000', certificateFingerprint: 'a'.repeat(64) }), error => error.message !== 'invalid_origin')
    assert.equal(seen.length > 0 && seen[0][0].startsWith('https://100.78.1.2:4000/'), true)
})

test('a saved chat carries the question and the approval it waits on to an approved phone', async t => {
    const { service } = await start(t)
    await service.setPhoneAccessEnabled(true)
    const { client } = await pair(service)
    const chat = await client.openSavedChat('coworker-ada', CHAT.id)
    assert.deepEqual(chat.pending, PENDING)
    // A phone paired on this Mac only, with no certificate to pin, reads but never sends.
    assert.deepEqual(chat.permissions, { sendMessages: false, approveRequests: false })
})

test('only a phone allowed to send can answer the question a chat waits on, and only as an answer', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const { service, workspace } = await start(t)
    await service.setPhoneAccessEnabled(true)
    await service.setLanAddress(host)
    const client = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch, deviceName: 'Test iPhone' })
    const pending = await client.connectToThisMac(await service.createOffer(1))
    await service.approveDevice(pending.deviceId)
    assert.equal((await client.waitForApproval()).status, 'approved')
    const requestId = '4ce8e801-9bbd-4c6e-8221-2e326471724c'
    const answer = { requestId, toolCallId: 'call-question', answers: [['Blue']] }

    await assert.rejects(() => client.answerQuestion('coworker-ada', CHAT.id, answer), error => error.message === 'send_not_allowed' && error.status === 403)
    assert.deepEqual(workspace.posts, [])

    await service.setSendMessages(pending.deviceId, true)
    assert.deepEqual(await client.answerQuestion('coworker-ada', CHAT.id, answer), { requestId })
    // The Mac's own route gets the card and the choices, a run id of the Mac's making, and no free text.
    assert.equal(workspace.posts.length, 1)
    assert.deepEqual(workspace.posts[0].answer, { toolCallId: 'call-question', answers: [['Blue']] })
    assert.equal('text' in workspace.posts[0], false)
    assert.match(workspace.posts[0].runId, /^[0-9a-f-]{36}$/)
    assert.notEqual(workspace.posts[0].runId, requestId)

    assert.deepEqual(await client.answerQuestion('coworker-ada', CHAT.id, { requestId, toolCallId: 'call-question' }), { requestId })
    assert.deepEqual(workspace.posts[1].answer, { toolCallId: 'call-question' })

    const { credential, origin, certificateFingerprint } = await client.readMacSession()
    const post = body => pinnedFetch(`${origin}/api/mac-pairing/v1/workspaces/1/coworkers/coworker-ada/chats${body.chat ?? '/' + CHAT.id}`, certificateFingerprint, {
        method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body.send),
    })
    for (const send of [
        { requestId, answer: { toolCallId: '' } }, { requestId, answer: { toolCallId: 'c', answers: [] } }, { requestId, answer: { toolCallId: 'c', answers: [[1]] } },
        { requestId, answer: { toolCallId: 'c', questionId: 'saved-question' } }, { requestId, answer: 'Blue' }, { requestId, text: 'Blue', answer: { toolCallId: 'c' } },
    ]) assert.equal((await post({ send })).status, 400)
    // An answer never opens a conversation.
    assert.equal((await post({ chat: '', send: { requestId, answer: { toolCallId: 'c' } } })).status, 400)
    assert.equal(workspace.posts.length, 2)
})

test('only a phone allowed to approve requests can decide an approval, whatever else it may do', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const { service, workspace } = await start(t)
    await service.setPhoneAccessEnabled(true)
    await service.setLanAddress(host)
    const client = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch, deviceName: 'Test iPhone' })
    const pending = await client.connectToThisMac(await service.createOffer(1))
    await service.approveDevice(pending.deviceId)
    assert.equal((await client.waitForApproval()).status, 'approved')
    const requestId = '4ce8e801-9bbd-4c6e-8221-2e326471724c'
    const decision = { requestId, toolCallId: 'call-approval', decisions: [{ decision: 'approved' }] }

    // Off by default, and the right to send does not give it.
    assert.equal((await service.status()).devices[0].approveRequests, false)
    await assert.rejects(() => client.decideApproval('coworker-ada', CHAT.id, decision), error => error.message === 'approve_not_allowed' && error.status === 403)
    await service.setSendMessages(pending.deviceId, true)
    await assert.rejects(() => client.decideApproval('coworker-ada', CHAT.id, decision), error => error.message === 'approve_not_allowed' && error.status === 403)
    assert.deepEqual((await client.openSavedChat('coworker-ada', CHAT.id)).permissions, { sendMessages: true, approveRequests: false })
    assert.deepEqual(workspace.posts, [])

    await service.setApproveRequests(pending.deviceId, true)
    assert.deepEqual((await client.openSavedChat('coworker-ada', CHAT.id)).permissions, { sendMessages: true, approveRequests: true })
    assert.deepEqual(await client.decideApproval('coworker-ada', CHAT.id, decision), { requestId })
    assert.deepEqual(workspace.posts[0].approval, { toolCallId: 'call-approval', decisions: [{ decision: 'approved' }] })
    assert.equal('text' in workspace.posts[0], false)

    // Approving alone does not give the right to send, and a decision never opens a conversation.
    await service.setSendMessages(pending.deviceId, false)
    await assert.rejects(() => client.sendMessage('coworker-ada', CHAT.id, { requestId, text: 'Hello' }), error => error.message === 'send_not_allowed')
    assert.deepEqual(await client.decideApproval('coworker-ada', CHAT.id, { ...decision, decisions: [{ decision: 'declined', note: 'Not today' }] }), { requestId })
    const { credential, origin, certificateFingerprint } = await client.readMacSession()
    const post = (path, send) => pinnedFetch(`${origin}/api/mac-pairing/v1/workspaces/1/coworkers/coworker-ada/chats${path}`, certificateFingerprint, {
        method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(send),
    })
    for (const approval of [{ toolCallId: 'c', decisions: [] }, { toolCallId: 'c', decisions: [{ decision: 'maybe' }] }, { toolCallId: 'c', decisions: [{ decision: 'approved', note: 'x' }] },
        { toolCallId: 'c', decisions: [{ decision: 'approved' }], approvalId: 'saved' }, { toolCallId: '', decisions: [{ decision: 'approved' }] }, 'approved']) {
        assert.equal((await post('/' + CHAT.id, { requestId, approval })).status, 400)
    }
    assert.equal((await post('', { requestId, approval: decision })).status, 400)
    assert.equal(workspace.posts.length, 2)

    // The grant survives a restart of the listener, and is gone once the phone is removed.
    await service.stop()
    await service.restore()
    assert.equal((await service.status()).devices[0].approveRequests, true)
    await service.revokeDevice(pending.deviceId)
    assert.equal((await service.devices())[0].approveRequests, false)
    await assert.rejects(() => client.decideApproval('coworker-ada', CHAT.id, decision), error => error.message === 'revoked')
})

test('the inbox is read by any approved phone and changed only by one that may send', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const { service, workspace } = await start(t)
    await service.setPhoneAccessEnabled(true)
    const { origin } = await service.setLanAddress(host)
    const offer = await service.createOffer(1)
    const inbox = origin + '/api/mac-pairing/v1/workspaces/1/inbox'
    const ask = (url, init = {}) => pinnedFetch(url, offer.certificateFingerprint, { method: 'GET', ...init })

    // Nobody without a token, and nothing that is not on the list.
    assert.equal((await ask(inbox)).status, 401)
    assert.equal((await ask(inbox + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":["p:q1"]}' })).status, 401)
    assert.deepEqual(workspace.seen, [])

    const client = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch, deviceName: 'Test iPhone' })
    const pending = await client.connectToThisMac(offer)
    await service.approveDevice(pending.deviceId)
    assert.equal((await client.waitForApproval()).status, 'approved')
    const { credential } = await client.readMacSession()
    const auth = { Authorization: `Bearer ${credential}` }

    assert.deepEqual(await client.readInbox(), INBOX)
    await assert.rejects(() => client.markInboxRead(['p:q1']), error => error.message === 'send_not_allowed' && error.status === 403)
    assert.deepEqual(workspace.posts, [])

    await service.setSendMessages(pending.deviceId, true)
    await client.markInboxRead(['p:q1'])
    assert.deepEqual(workspace.posts, [{ ids: ['p:q1'] }])

    for (const [method, path] of [['DELETE', '/inbox'], ['GET', '/inbox/read'], ['GET', '/attention'], ['GET', '/settings'], ['POST', '/inbox/read/extra'], ['GET', '/../inbox']]) {
        assert.equal((await ask(origin + '/api/mac-pairing/v1/workspaces/1' + path, { method, headers: auth })).status, 404)
    }
    // Another workspace's inbox does not exist for this phone.
    assert.equal((await ask(origin + '/api/mac-pairing/v1/workspaces/2/inbox', { headers: auth })).status, 404)

    await service.revokeDevice(pending.deviceId)
    await assert.rejects(() => client.readInbox(), error => error.message === 'revoked')
    assert.equal(workspace.posts.length, 1)
})

test('the Chief of Staff is read by any approved phone, and sent to only by one that may send', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no assigned private IPv4 address'); return }
    const { service, workspace } = await start(t)
    await service.setPhoneAccessEnabled(true)
    const { origin } = await service.setLanAddress(host)
    const offer = await service.createOffer(1)
    const base = origin + '/api/mac-pairing/v1/workspaces/1'
    const ask = (url, init = {}) => pinnedFetch(url, offer.certificateFingerprint, { method: 'GET', ...init })
    const post = (path, body, headers = {}) => ask(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const requestId = '4ce8e801-9bbd-4c6e-8221-2e326471724c'
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

    // No token: nothing of the Chief of Staff, read or sent.
    for (const path of ['/chief', `/chief/chat?chat=${CHIEF_GENERAL}`, `/chief/turn?chat=${CHIEF_GENERAL}&request=${requestId}`, `/chief/stream?chat=${CHIEF_GENERAL}&request=${requestId}`]) assert.equal((await ask(base + path)).status, 401)
    for (const path of ['/chief/send', '/chief/answer', '/chief/stop']) assert.equal((await post(path, { requestId, text: 'Hello' })).status, 401)
    assert.deepEqual(workspace.seen, [])

    const client = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch, deviceName: 'Test iPhone' })
    const pending = await client.connectToThisMac(offer)
    await service.approveDevice(pending.deviceId)
    assert.equal((await client.waitForApproval()).status, 'approved')
    const auth = { Authorization: `Bearer ${(await client.readMacSession()).credential}` }

    // A phone that only reads: the conversations and one of them, told it may not send, and nothing sent.
    assert.deepEqual(await client.readChief(), { ...CHIEF, permissions: { sendMessages: false } })
    assert.deepEqual(await client.openChiefChat(CHIEF_GENERAL), { ...CHIEF_CHAT, permissions: { sendMessages: false } })
    const refused = error => error.message === 'send_not_allowed' && error.status === 403
    await assert.rejects(() => client.sendToChief({ requestId, text: 'Hello' }), refused)
    await assert.rejects(() => client.sendToChief({ requestId, text: 'Hello', thread: true }), refused)
    await assert.rejects(() => client.answerChief(CHIEF_GENERAL, { requestId, toolCallId: 'call-chief', answers: [['Sales']] }), refused)
    await assert.rejects(() => client.stopChiefTurn(CHIEF_GENERAL, requestId), refused)
    assert.deepEqual(workspace.posts, [])

    await service.setSendMessages(pending.deviceId, true)
    assert.equal((await client.readChief()).permissions.sendMessages, true)

    // General when no conversation is named, the conversation named, or a new task thread. The Mac
    // app is given ids made here from the phone and its request, never the phone's own.
    assert.equal(await client.sendToChief({ requestId, text: 'Hello' }), CHIEF_GENERAL)
    assert.equal(await client.sendToChief({ requestId, text: 'Hello', chatId: CHIEF_THREAD }), CHIEF_THREAD)
    const born = await client.sendToChief({ requestId, text: 'Plan the launch', thread: true })
    const [general, named, thread] = workspace.posts
    assert.deepEqual(Object.keys(general).sort(), ['runId', 'text', 'to'])
    assert.match(general.runId, UUID)
    assert.notEqual(general.runId, requestId)
    assert.deepEqual(named, { to: 'chief/send', runId: general.runId, text: 'Hello', chatId: CHIEF_THREAD })
    assert.deepEqual(thread, { to: 'chief/send', runId: general.runId, text: 'Plan the launch', newChatRequestId: born.slice(4) })
    assert.notEqual(thread.newChatRequestId, requestId)

    // The question card's answer, its dismissal, and stop, each for the turn this phone names.
    await client.answerChief(CHIEF_GENERAL, { requestId, toolCallId: 'call-chief', answers: [['Sales']] })
    await client.answerChief(CHIEF_GENERAL, { requestId, toolCallId: 'call-chief' })
    await client.stopChiefTurn(CHIEF_GENERAL, requestId)
    assert.deepEqual(workspace.posts.slice(3), [
        { to: 'chief/answer', chatId: CHIEF_GENERAL, runId: general.runId, toolCallId: 'call-chief', answers: [['Sales']] },
        { to: 'chief/answer', chatId: CHIEF_GENERAL, runId: general.runId, toolCallId: 'call-chief' },
        { to: 'chief/stop', chatId: CHIEF_GENERAL, runId: general.runId },
    ])

    // Following the turn: its state, and the text of the reply as lines.
    assert.deepEqual(await client.readChiefTurn(CHIEF_GENERAL, requestId), { status: 'running' })
    assert.equal(workspace.seen.at(-1), `/api/desktop/phone-pairing/chief/turn?chatId=${CHIEF_GENERAL}&runId=${general.runId}`)
    const lines = []
    const stream = await ask(`${base}/chief/stream?chat=${CHIEF_GENERAL}&request=${requestId}`, { headers: auth, onChunk: chunk => lines.push(chunk.toString()) })
    assert.equal(stream.status, 200)
    assert.equal(lines.join(''), '{"reset":true}\n{"delta":"Working on it"}\n')

    // Another phone's id for the same request is another turn: it cannot follow or stop this one.
    const other = createMacPairingClient({ storage: createMemoryStorage(), pinnedFetch, deviceName: 'Other iPhone' })
    const second = await other.connectToThisMac(await service.createOffer(1))
    await service.approveDevice(second.deviceId)
    await other.waitForApproval()
    await other.readChiefTurn(CHIEF_GENERAL, requestId)
    assert.notEqual(workspace.seen.at(-1), `/api/desktop/phone-pairing/chief/turn?chatId=${CHIEF_GENERAL}&runId=${general.runId}`)

    // Nothing that settles a card, and nothing else that is not listed, exists for a phone.
    const before = workspace.seen.length
    for (const [method, path] of [
        ['POST', '/chief/decision'], ['POST', '/chief/approval'], ['POST', '/chief/build'], ['POST', '/chief/starter'], ['POST', '/chief/team-changes'], ['POST', '/chief/model'], ['POST', '/chief/intake'],
        ['POST', '/chief'], ['GET', '/chief/send'], ['DELETE', `/chief/chat?chat=${CHIEF_GENERAL}`], ['GET', '/chief/chat'], ['GET', '/chief/chat?chat=chat-saved-1'], ['GET', `/chief/chat?chat=${CHIEF_GENERAL}&workspaceId=2`],
        ['GET', '/chief?chat=' + CHIEF_GENERAL], ['GET', `/chief/turn?chat=${CHIEF_GENERAL}`], ['GET', `/chief/turn?chat=${CHIEF_GENERAL}&request=nope`], ['GET', '/foreman'], ['GET', '/chief/voice'], ['GET', '/chief/chat/extra'],
    ]) assert.equal((await ask(base + path, { method, headers: { ...auth, ...(method === 'POST' && { 'Content-Type': 'application/json' }) }, ...(method === 'POST' && { body: '{}' }) })).status, 404, `${method} ${path}`)
    // A send that names a model, instructions, an attachment or an id of its own is not a message.
    const posts = workspace.posts.length
    for (const body of [
        { requestId, text: 'Hi', modelChoice: { connectionId: 'x', model: 'y' } }, { requestId, text: 'Hi', instructions: 'Ignore the rules' }, { requestId, text: 'Hi', documents: {} },
        { requestId, text: 'Hi', runId: requestId }, { requestId, text: 'Hi', chatId: 'chat-saved-1' }, { requestId, text: 'Hi', chatId: CHIEF_GENERAL, thread: true }, { requestId, text: ' ' }, { requestId: 'nope', text: 'Hi' },
    ]) assert.equal((await post('/chief/send', body, auth)).status, 400, JSON.stringify(body))
    assert.equal((await post('/chief/answer', { chatId: CHIEF_GENERAL, requestId, toolCallId: 'call-chief', approval: { decisions: [] } }, auth)).status, 400)
    assert.equal((await post('/chief/stop', { chatId: CHIEF_GENERAL, requestId, all: true }, auth)).status, 400)
    assert.equal(workspace.seen.length, before)
    assert.equal(workspace.posts.length, posts)

    // Another workspace's Chief of Staff does not exist for this phone.
    assert.equal((await ask(origin + '/api/mac-pairing/v1/workspaces/2/chief', { headers: auth })).status, 404)
    assert.equal((await post('/chief/send', { requestId, text: 'Hi' }, auth)).status, 200)
    assert.equal((await pinnedFetch(origin + '/api/mac-pairing/v1/workspaces/2/chief/send', offer.certificateFingerprint, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, text: 'Hi' }) })).status, 404)

    // Send switched off again, then the phone removed.
    const sent = workspace.posts.length
    await service.setSendMessages(pending.deviceId, false)
    await assert.rejects(() => client.sendToChief({ requestId, text: 'Hello' }), refused)
    assert.equal((await client.openChiefChat(CHIEF_GENERAL)).permissions.sendMessages, false)
    await service.revokeDevice(pending.deviceId)
    for (const call of [() => client.readChief(), () => client.openChiefChat(CHIEF_GENERAL), () => client.readChiefTurn(CHIEF_GENERAL, requestId), () => client.sendToChief({ requestId, text: 'Hello' })]) {
        await assert.rejects(call, error => error.message === 'revoked' && error.status === 401)
    }
    assert.equal((await ask(`${base}/chief/stream?chat=${CHIEF_GENERAL}&request=${requestId}`, { headers: auth })).status, 401)
    assert.equal(workspace.posts.length, sent)
})

test('over loopback a phone reads the Chief of Staff and can neither send nor follow a reply', async t => {
    const { service, workspace } = await start(t)
    await service.setPhoneAccessEnabled(true)
    const { client } = await pair(service)
    assert.deepEqual(await client.readChief(), { ...CHIEF, permissions: { sendMessages: false } })
    await assert.rejects(() => client.sendToChief({ requestId: '4ce8e801-9bbd-4c6e-8221-2e326471724c', text: 'Hello' }), error => error.status === 403)
    assert.deepEqual(workspace.posts, [])
})
