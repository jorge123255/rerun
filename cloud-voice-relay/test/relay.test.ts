import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, test } from 'node:test'
import { relaySigningInput, verifyRelayAuth } from '../src/auth.ts'
import { relayClock } from '../src/index.ts'
import { CLOSE, LIMITS } from '../src/protocol.ts'
import { FakeWorld, installRuntime, type FakeSocket } from './fake-runtime.ts'

const runtime = installRuntime()
const INSTALL = 'iNsTaLl_id-0123456789abcdefghijklmnopqrstuv'
const SECRET = 'cmVsYXktc2VjcmV0LWZvci10aGUtdmVjdG9yLTMyYnk'
const OTHER_SECRET = 'b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldC1vdGhlciE'
const HOST = 'voice.example.test'
const MAC_URL = `https://${HOST}/v1/${INSTALL}/mac`
const ELEVENLABS_URL = `https://${HOST}/v1/${INSTALL}/speech-engine`
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2ln'
const T0 = 1_790_000_000_000

let now = T0
const isOpen = (socket: FakeSocket) => socket.closed === null
const logged: unknown[][] = []
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
beforeEach(() => {
    now = T0
    relayClock.now = () => now
    logged.length = 0
    for (const name of Object.keys(originals) as (keyof typeof originals)[]) console[name] = (...args: unknown[]) => { logged.push(args) }
})
afterEach(() => { Object.assign(console, originals) })

function world(extra: Record<string, string> = {}) {
    const created = new FakeWorld({ RELAY_INSTALLS: JSON.stringify({ [INSTALL]: SECRET }), ...extra })
    runtime.withWorld(created)
    return created
}

function signature(secret: string, timestamp: number, nonce: string, path = `/v1/${INSTALL}/mac`, host = HOST) {
    const digest = createHmac('sha256', Buffer.from(secret, 'base64url')).update(relaySigningInput(INSTALL, host, path, timestamp, nonce)).digest('base64url')
    return `v1.${timestamp}.${nonce}.${digest}`
}

async function connectMac(relay: FakeWorld, options: { secret?: string; at?: number; nonce?: string; header?: string | null } = {}) {
    const nonce = options.nonce ?? randomBytes(16).toString('base64url')
    const header = options.header === undefined ? signature(options.secret ?? SECRET, Math.floor((options.at ?? now) / 1000), nonce) : options.header
    const response = await relay.fetch(new Request(MAC_URL, { headers: { upgrade: 'websocket', ...(header !== null && { 'x-rerun-relay-auth': header }) } }))
    await relay.settle()
    return { response, socket: (response as Response & { webSocket?: FakeSocket }).webSocket }
}

async function connectElevenLabs(relay: FakeWorld, headers: Record<string, string> = { 'x-elevenlabs-speech-engine-authorization': JWT }) {
    const response = await relay.fetch(new Request(ELEVENLABS_URL, { headers: { upgrade: 'websocket', ...headers } }))
    await relay.settle()
    return { response, socket: (response as Response & { webSocket?: FakeSocket }).webSocket }
}

async function send(relay: FakeWorld, socket: FakeSocket, message: unknown) {
    socket.send(typeof message === 'string' ? message : JSON.stringify(message))
    await relay.settle()
}

async function announce(relay: FakeWorld, mac: FakeSocket, conversationId: string) {
    await send(relay, mac, { type: 'announce', conversationId, ttlMs: 120_000 })
    assert.deepEqual(mac.json().at(-1), { type: 'announced', conversationId })
}

async function openConversation(relay: FakeWorld, mac: FakeSocket, conversationId = 'conv_abc') {
    await announce(relay, mac, conversationId)
    const { socket } = await connectElevenLabs(relay)
    const open = mac.json().at(-1)
    assert.equal(open.type, 'open')
    await send(relay, socket!, { type: 'init', conversation_id: conversationId })
    return { elevenlabs: socket!, channel: open.channel as string }
}

test('the signature format matches the fixed vector the Mac is tested against', async () => {
    const vector = relaySigningInput('install-id-for-vector', 'Relay.Example.Test', '/v1/install-id-for-vector/mac', 1_790_000_000, 'bm9uY2Utbm9uY2Utbm9uY2U')
    assert.equal(vector, 'rerun-voice-relay-v1\ninstall-id-for-vector\nrelay.example.test\n/v1/install-id-for-vector/mac\n1790000000\nbm9uY2Utbm9uY2Utbm9uY2U')
    const digest = createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(vector).digest('base64url')
    assert.equal(digest, 'TjJ--vQwYwm-LQQ0AiS3iJ1XXjWz3zvhHjcvFDq6Q8U')
})

test('an unknown install or path does not exist, and a plain request is not an upgrade', async () => {
    const relay = world()
    const other = 'x'.repeat(43)
    for (const url of [`https://${HOST}/`, `https://${HOST}/v1/${other}/mac`, `https://${HOST}/v1/${INSTALL}/other`, `${MAC_URL}?x=1`, `https://${HOST}/v1/short/mac`]) {
        assert.equal((await relay.fetch(new Request(url, { headers: { upgrade: 'websocket' } }))).status, 404)
    }
    assert.equal((await relay.fetch(new Request(MAC_URL))).status, 426)
    assert.equal((await world({ RELAY_INSTALLS: 'not json' }).fetch(new Request(MAC_URL, { headers: { upgrade: 'websocket' } }))).status, 404)
    assert.equal((await world({ RELAY_INSTALLS: JSON.stringify({ [INSTALL]: 'short' }) }).fetch(new Request(MAC_URL, { headers: { upgrade: 'websocket' } }))).status, 404)
})

test('the Mac connects only with a fresh signature made with its own secret, once per nonce', async () => {
    const relay = world()
    assert.equal((await connectMac(relay, { header: null })).response.status, 401)
    assert.equal((await connectMac(relay, { secret: OTHER_SECRET })).response.status, 401)
    assert.equal((await connectMac(relay, { at: now - (LIMITS.authWindowSeconds + 5) * 1000 })).response.status, 401)
    assert.equal((await connectMac(relay, { at: now + (LIMITS.authWindowSeconds + 5) * 1000 })).response.status, 401)
    assert.equal((await connectMac(relay, { header: 'v1.1.2.3' })).response.status, 401)
    const nonce = randomBytes(16).toString('base64url')
    const first = await connectMac(relay, { nonce })
    assert.equal(first.response.status, 101)
    assert.deepEqual(first.socket!.json()[0], { type: 'ready', maxConversations: 2, channels: [] })
    assert.equal((await connectMac(relay, { nonce })).response.status, 401, 'a replayed header is refused')
    // A signature for another host or path does not carry over.
    const elsewhere = signature(SECRET, Math.floor(now / 1000), randomBytes(16).toString('base64url'), `/v1/${INSTALL}/mac`, 'other.example.test')
    assert.equal((await connectMac(relay, { header: elsewhere })).response.status, 401)
})

test('WebCrypto verification agrees with the Node signer and rejects a changed byte', async () => {
    const nonce = randomBytes(16).toString('base64url'), at = Math.floor(now / 1000)
    const header = signature(SECRET, at, nonce)
    const input = { secret: SECRET, installId: INSTALL, host: HOST, path: `/v1/${INSTALL}/mac`, nowSeconds: at, windowSeconds: 30 }
    assert.equal((await verifyRelayAuth({ ...input, header })).ok, true)
    const flipped = header.slice(0, -2) + (header.at(-2) === 'A' ? 'B' : 'A') + header.at(-1)
    assert.equal((await verifyRelayAuth({ ...input, header: flipped })).ok, false)
})

test('ElevenLabs is refused while no Mac is connected, and without its authorization header', async () => {
    const relay = world()
    assert.equal((await connectElevenLabs(relay)).response.status, 503)
    const { socket: mac } = await connectMac(relay)
    assert.equal((await connectElevenLabs(relay, {})).response.status, 401)
    assert.equal((await connectElevenLabs(relay, { 'x-elevenlabs-speech-engine-authorization': 'x'.repeat(LIMITS.authorizationMaxChars + 1) })).response.status, 401)
    const { response } = await connectElevenLabs(relay)
    assert.equal(response.status, 101)
    const open = mac!.json().at(-1)
    assert.equal(open.type, 'open')
    assert.equal(open.authorization, JWT, 'the header reaches the Mac untouched')
    mac!.close(1000)
    await relay.settle()
    assert.equal((await connectElevenLabs(relay)).response.status, 503)
})

test('only an announced conversation is piped, once, and text flows both ways', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    const stranger = (await connectElevenLabs(relay)).socket!
    await send(relay, stranger, { type: 'init', conversation_id: 'conv_never_announced' })
    assert.equal(stranger.closed?.code, CLOSE.notAnnounced)
    assert.equal(mac!.json().filter(frame => frame.type === 'frame').length, 0)

    const { elevenlabs, channel } = await openConversation(relay, mac!)
    assert.deepEqual(mac!.json().at(-1), { type: 'frame', channel, message: { type: 'init', conversation_id: 'conv_abc' } })
    await send(relay, elevenlabs, { type: 'user_transcript', user_transcript: [{ role: 'user', content: 'Hello there', extra: 1 }], event_id: 3, junk: true })
    assert.deepEqual(mac!.json().at(-1), { type: 'frame', channel, message: { type: 'user_transcript', user_transcript: [{ role: 'user', content: 'Hello there' }], event_id: 3 } })
    await send(relay, mac!, { type: 'send', channel, message: { type: 'agent_response', content: 'Hi.', event_id: 3, is_final: false, extra: 'dropped' } })
    await send(relay, mac!, { type: 'send', channel, message: { type: 'something_else' } })
    assert.deepEqual(elevenlabs.json(), [{ type: 'agent_response', content: 'Hi.', event_id: 3, is_final: false }])

    // The same conversation cannot be opened twice.
    const again = (await connectElevenLabs(relay)).socket!
    await send(relay, again, { type: 'init', conversation_id: 'conv_abc' })
    assert.equal(again.closed?.code, CLOSE.notAnnounced)

    // A second init on a bound connection is a protocol error.
    await send(relay, elevenlabs, { type: 'init', conversation_id: 'conv_abc' })
    assert.equal(elevenlabs.closed?.code, CLOSE.policy)
    assert.deepEqual(mac!.json().at(-1), { type: 'closed', channel })
})

test('frames before init are refused, and text for a connection without a conversation is held back', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    const elevenlabs = (await connectElevenLabs(relay)).socket!
    const { channel } = mac!.json().at(-1)
    await send(relay, mac!, { type: 'send', channel, message: { type: 'agent_response', content: 'early', is_final: true } })
    assert.deepEqual(elevenlabs.json(), [])
    await send(relay, elevenlabs, { type: 'user_transcript', user_transcript: [], event_id: 1 })
    assert.equal(elevenlabs.closed?.code, CLOSE.policy)
})

test('an announcement expires', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    await send(relay, mac!, { type: 'announce', conversationId: 'conv_late', ttlMs: 1_000 })
    now += 2_000
    const elevenlabs = (await connectElevenLabs(relay)).socket!
    await send(relay, elevenlabs, { type: 'init', conversation_id: 'conv_late' })
    assert.equal(elevenlabs.closed?.code, CLOSE.notAnnounced)
})

test('at most two conversations at once, and a small cap on pending announcements', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    await openConversation(relay, mac!, 'conv_one')
    await openConversation(relay, mac!, 'conv_two')
    assert.equal((await connectElevenLabs(relay)).response.status, 429)
    for (let index = 0; index < LIMITS.maxAnnounced; index++) await announce(relay, mac!, `conv_pending_${index}`)
    await send(relay, mac!, { type: 'announce', conversationId: 'conv_too_many', ttlMs: 60_000 })
    assert.deepEqual(mac!.json().at(-1), { type: 'refused', conversationId: 'conv_too_many', reason: 'full' })
})

test('oversize, binary and too frequent frames close the connection', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    const big = (await openConversation(relay, mac!, 'conv_big')).elevenlabs
    await send(relay, big, JSON.stringify({ type: 'user_transcript', user_transcript: [{ role: 'user', content: 'x'.repeat(LIMITS.upstreamFrameBytes) }], event_id: 1 }))
    assert.equal(big.closed?.code, CLOSE.tooBig)

    const binary = (await openConversation(relay, mac!, 'conv_binary')).elevenlabs
    binary.send(new ArrayBuffer(4))
    await relay.settle()
    assert.equal(binary.closed?.code, CLOSE.unsupported)

    const fast = (await openConversation(relay, mac!, 'conv_fast')).elevenlabs
    for (let index = 0; index < LIMITS.upstreamRate.burst + 5; index++) fast.send(JSON.stringify({ type: 'user_transcript', user_transcript: [], event_id: index }))
    await relay.settle()
    assert.equal(fast.closed?.code, CLOSE.rate)
    // Spaced out, the same number of frames is fine.
    const steady = (await openConversation(relay, mac!, 'conv_steady')).elevenlabs
    for (let index = 0; index < LIMITS.upstreamRate.burst + 5; index++) {
        now += 200
        await send(relay, steady, { type: 'user_transcript', user_transcript: [], event_id: index })
    }
    assert.equal(isOpen(steady), true)
})

test('pings are answered by the relay and are not passed to the Mac', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    const { elevenlabs } = await openConversation(relay, mac!)
    const before = mac!.received.length
    await send(relay, elevenlabs, '{"type":"ping"}')
    await send(relay, elevenlabs, { type: 'ping', event_id: 4 })
    assert.deepEqual(elevenlabs.json(), [{ type: 'pong' }, { type: 'pong' }])
    await send(relay, mac!, '{"type":"ping"}')
    assert.deepEqual(mac!.json().at(-1), { type: 'pong' })
    assert.equal(mac!.received.length, before + 1)
})

test('the Mac leaving closes every conversation; a reconnecting Mac takes over and is told what is open', async () => {
    const relay = world()
    const first = (await connectMac(relay)).socket!
    const { elevenlabs, channel } = await openConversation(relay, first)
    const second = (await connectMac(relay)).socket!
    assert.equal(first.closed?.code, CLOSE.replaced)
    assert.deepEqual(second.json()[0], { type: 'ready', maxConversations: 2, channels: [channel] })
    assert.equal(isOpen(elevenlabs), true, 'a replaced Mac does not end the conversation')
    await send(relay, elevenlabs, { type: 'user_transcript', user_transcript: [{ role: 'user', content: 'still here' }], event_id: 9 })
    assert.equal(second.json().at(-1).type, 'frame')
    second.close(1000)
    await relay.settle()
    assert.equal(elevenlabs.closed?.code, CLOSE.internal)
})

test('state survives hibernation between frames', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    await announce(relay, mac!, 'conv_sleepy')
    relay.object(INSTALL).hibernate()
    const elevenlabs = (await connectElevenLabs(relay)).socket!
    relay.object(INSTALL).hibernate()
    await send(relay, elevenlabs, { type: 'init', conversation_id: 'conv_sleepy' })
    relay.object(INSTALL).hibernate()
    const { channel } = mac!.json().find(frame => frame.type === 'open')
    await send(relay, mac!, { type: 'send', channel, message: { type: 'agent_response', content: 'Awake.', event_id: 1, is_final: false } })
    assert.deepEqual(elevenlabs.json(), [{ type: 'agent_response', content: 'Awake.', event_id: 1, is_final: false }])
})

test('idle connections and connections that never start are closed by the alarm', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    const silent = (await connectElevenLabs(relay)).socket!
    const { elevenlabs } = await openConversation(relay, mac!, 'conv_idle')
    now += LIMITS.initTimeoutMs + 1
    await send(relay, mac!, '{"type":"ping"}')
    await relay.object(INSTALL).instance.alarm()
    await relay.settle()
    assert.equal(silent.closed?.code, CLOSE.timeout)
    assert.equal(isOpen(elevenlabs), true)
    now += LIMITS.upstreamIdleMs + 1
    await send(relay, mac!, '{"type":"ping"}')
    await relay.object(INSTALL).instance.alarm()
    await relay.settle()
    assert.equal(elevenlabs.closed?.code, CLOSE.timeout)
    assert.equal(isOpen(mac!), true, 'the Mac kept itself alive with pings')
    now += LIMITS.macIdleMs + 1
    await relay.object(INSTALL).instance.alarm()
    await relay.settle()
    assert.equal(mac!.closed?.code, CLOSE.timeout)
})

test('the ElevenLabs address check is off by default and, when on, admits only listed addresses', async () => {
    const off = world()
    await connectMac(off)
    assert.equal((await connectElevenLabs(off, { 'x-elevenlabs-speech-engine-authorization': JWT, 'cf-connecting-ip': '203.0.113.9' })).response.status, 101)
    const on = world({ ELEVENLABS_EGRESS_CHECK: 'on', ELEVENLABS_EGRESS_IPS: '34.67.146.145, 34.59.11.47' })
    await connectMac(on)
    assert.equal((await connectElevenLabs(on, { 'x-elevenlabs-speech-engine-authorization': JWT, 'cf-connecting-ip': '203.0.113.9' })).response.status, 403)
    assert.equal((await connectElevenLabs(on, { 'x-elevenlabs-speech-engine-authorization': JWT })).response.status, 403)
    assert.equal((await connectElevenLabs(on, { 'x-elevenlabs-speech-engine-authorization': JWT, 'cf-connecting-ip': '34.59.11.47' })).response.status, 101)
})

test('a caller cannot set the relay\'s internal headers', async () => {
    const relay = world()
    const forged = await relay.fetch(new Request(ELEVENLABS_URL, { headers: { upgrade: 'websocket', 'x-relay-role': 'mac', 'x-relay-nonce': 'n'.repeat(22), 'x-relay-timestamp': '1', 'x-elevenlabs-speech-engine-authorization': JWT } }))
    assert.equal(forged.status, 503, 'still treated as ElevenLabs, and no Mac is connected')
})

test('nothing is logged: not the token, not what anyone says', async () => {
    const relay = world()
    const { socket: mac } = await connectMac(relay)
    const { elevenlabs, channel } = await openConversation(relay, mac!)
    await send(relay, elevenlabs, { type: 'user_transcript', user_transcript: [{ role: 'user', content: 'my secret plans' }], event_id: 1 })
    await send(relay, mac!, { type: 'send', channel, message: { type: 'agent_response', content: 'noted', event_id: 1, is_final: true } })
    await send(relay, elevenlabs, 'not json')
    assert.deepEqual(logged, [])
})
