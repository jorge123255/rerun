import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPinnedRemoteNetwork, createRemoteProtocolClient, remoteAddress, approvedAddress } from './network.mjs'
import { remoteIdentity, FIXTURE_KEY } from './fixtures.mjs'
const signal = () => new AbortController().signal
const check = async () => {}
function scriptedNetwork(reply) {
    const calls = []
    const network = createPinnedRemoteNetwork({
        resolve: async () => [{ address: '10.10.10.10', family: 4 }], inspectPeer: () => 'a'.repeat(64),
        request(url, options, incoming) {
            calls.push({ url, options })
            const req = new EventEmitter(); req.destroy = () => { req.destroyed = true }
            req.end = () => queueMicrotask(() => {
                const socket = new EventEmitter(); socket.remoteAddress = '10.10.10.10'; socket.setTimeout = () => {}
                req.emit('socket', socket); socket.emit('secureConnect')
                const value = reply(url), response = new EventEmitter()
                response.statusCode = value.status ?? 200; response.headers = value.headers ?? { 'content-type': 'application/json' }
                response.destroy = () => { response.destroyed = true }; incoming(response)
                if (!response.destroyed) { response.emit('data', Buffer.from(value.body ?? '{}')); response.emit('end') }
            })
            return req
        },
    })
    return { network, calls }
}
test('manual origins preserve HTTPS and reject credentials, paths, queries and alternate local encodings', () => {
    assert.equal(remoteAddress('https://server.example:443/'), 'https://server.example')
    for (const input of ['http://server.example', 'https://u:p@server.example', 'https://server.example/path', 'https://server.example?key=x', 'https://server.example/#x']) assert.throws(() => remoteAddress(input))
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '169.254.169.254', 'fe80::1', '224.0.0.1']) assert.equal(approvedAddress(ip), false)
    assert.equal(approvedAddress('192.168.1.20'), true); assert.equal(approvedAddress('100.64.1.2'), true)
})
test('offline GET health/key/identity flow is bounded, pinned and never exposes connection contents', async () => {
    const { network, calls } = scriptedNetwork(url => ({ body: JSON.stringify(url.pathname === '/health' ? { status: 'ok', activeAgents: 2 }
        : url.pathname === '/connections' ? { connections: [] } : { identity: remoteIdentity, challenge: url.searchParams.get('challenge') }) }))
    const result = await createRemoteProtocolClient(network).probe({ address: 'https://server.example', apiKey: FIXTURE_KEY }, check, signal())
    assert.deepEqual(result.identity, remoteIdentity); assert.equal(calls.length, 3)
    assert.equal(calls[0].options.headers.Authorization, undefined)
    assert.equal(calls[1].options.headers.Authorization, `Bearer ${FIXTURE_KEY}`)
    assert.equal(calls.every(c => c.options.rejectUnauthorized === true && c.options.agent === false && typeof c.options.checkServerIdentity === 'function'), true)
    assert.equal(JSON.stringify(result).includes(FIXTURE_KEY), false)
})
test('redirects, compressed/oversized/malformed replies do not follow credentials or produce a connection', async () => {
    for (const reply of [
        { status: 302, headers: { location: 'https://other.example', 'content-type': 'application/json' } },
        { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } },
        { body: 'x'.repeat(131073) }, { body: '{' },
    ]) {
        const { network, calls } = scriptedNetwork(() => reply)
        await assert.rejects(network.json('https://server.example', '/connections', FIXTURE_KEY, 'a'.repeat(64), check, signal()))
        assert.equal(calls.length, 1); assert.equal(calls[0].url.origin, 'https://server.example')
    }
})
test('mixed DNS and Stop during resolution refuse before credential-bearing connection', async () => {
    let requests = 0
    const network = createPinnedRemoteNetwork({ resolve: async () => [{ address: '10.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { requests++ } })
    await assert.rejects(network.json('https://server.example', '/connections', FIXTURE_KEY, null, check, signal()))
    assert.equal(requests, 0)
    let entered
    const resolving = new Promise(resolve => { entered = resolve }), stop = new AbortController()
    const hung = createPinnedRemoteNetwork({ resolve: () => { entered(); return new Promise(() => {}) }, request: () => { requests++ } })
    const pending = hung.json('https://server.example', '/connections', FIXTURE_KEY, null, check, stop.signal)
    await resolving; stop.abort(); await assert.rejects(pending); assert.equal(requests, 0)
})
test('same-origin identity drift and unsupported old hosts remain explicit failures', async () => {
    for (const kind of ['wrong_machine', 'old_host']) {
        const network = { async json(_origin, path) {
            if (path === '/health') return { body: { status: 'ok', activeAgents: 0 }, tlsPin: 'a'.repeat(64) }
            if (path === '/connections') return { body: { connections: [] }, tlsPin: 'a'.repeat(64) }
            if (kind === 'old_host') throw Object.assign(new Error('No stable identity'), { code: 'unsupported' })
            const challenge = new URL(`https://server.example${path}`).searchParams.get('challenge')
            return { body: { identity: { ...remoteIdentity, workspaceId: 8 }, challenge }, tlsPin: 'a'.repeat(64) }
        } }
        await assert.rejects(createRemoteProtocolClient(network).probe({ address: 'https://server.example', apiKey: FIXTURE_KEY, expectedIdentity: remoteIdentity }, check, signal()), error => error.code === (kind === 'old_host' ? 'unsupported' : 'identity_changed'))
    }
})
