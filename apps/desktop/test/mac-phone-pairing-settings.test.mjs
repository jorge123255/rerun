// The listener talks to an isolated Mac workspace with a test session; nothing uses a model or an account.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMacPhonePairingService } from '../src/main/mac-phone-pairing/index.mjs'
import { localPairingAddresses } from '../src/main/mac-phone-pairing/lan-identity.mjs'
import { seedLegacyCatalog } from '../src/main/workspaces/catalog.mjs'
import { pinnedFetch } from './mac-phone-pairing-client-fixture.mjs'

const installId = 'c21e966a-8b8e-482a-b88b-f8f95da907fd'
const agentId = '81eee06b-2c26-4b4f-a630-91e7588aa96d'
const target = 'b13064f8-b57c-4156-b389-bc21ade5549a'
const requestId = '296c4b57-106b-4658-94a5-d0c25bb588ac'
const query = '?agentId=' + agentId
const edits = [
    ['PATCH', 'model', { action: 'coworker', connectionId: 'mock', model: 'local' }],
    ['PATCH', 'model', { action: 'follow-workspace' }],
    ['PUT', 'effort', { connectionId: 'mock', model: 'local', effort: null }],
    ['PATCH', 'tools', { group: 'rerun', id: 'callAgent', enabled: true }],
    ['PATCH', 'tools', { group: 'codex', id: 'workspaceRead', enabled: false }],
    ['PATCH', 'tools', { group: 'claude', id: 'claudeSubagents', enabled: true }],
    ['PATCH', 'call-targets', { targetAgentIds: [target], expectedTargetAgentIds: [] }],
    ['PATCH', 'settings', { soul: 'Prepare a brief.', description: 'Writer', verbosity: 'concise', repository: null }],
    ['PATCH', 'name', { name: 'Ada' }],
    ['PATCH', 'enabled', { enabled: false }],
    ['POST', 'box', { spaceId: target, expectedRevision: 3, requestId }],
    ['POST', 'setup', { action: 'skip', expectedRevision: 'r2', requestId }],
    ['POST', 'setup', { action: 'start', expectedRevision: 'r3', requestId }],
    ['POST', 'setup', { action: 'continue', expectedRevision: 'r4', requestId }],
]

async function fixture(t, host) {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-phone-settings-'))
    t.after(() => rm(dataRoot, { recursive: true, force: true }))
    await seedLegacyCatalog(dataRoot, installId)
    const calls = []
    const reply = { status: 200, body: { ok: true, privateReceiptField: 'never returned' } }
    const server = createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
        calls.push({ method: req.method, url: req.url, body, cookie: req.headers.cookie, origin: req.headers.origin })
        await reply.hold?.()
        res.writeHead(reply.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(reply.body))
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    t.after(() => new Promise(resolve => server.close(resolve)))
    const origin = 'http://127.0.0.1:' + server.address().port
    const runtime = { workspaceId: 1, app: { origin, sessionToken: 'synthetic-workspace-cookie' } }
    const hooks = { captured: null }
    let activeRuntime = runtime
    const options = { dataRoot, installId, getRuntime: () => {
        const captured = hooks.captured
        hooks.captured = null
        captured?.()
        return activeRuntime
    } }
    let service = createMacPhonePairingService(options)
    t.after(() => service.stop())
    await service.setPhoneAccessEnabled(true)
    if (host) await service.setLanAddress(host)
    const offer = await service.createOffer(1)
    const request = async (path, options) => {
        const url = offer.origin + '/api/mac-pairing/v1/' + path
        return host ? pinnedFetch(url, offer.certificateFingerprint, options) : fetch(url, options)
    }
    const post = async (path, body) => (await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
    const pending = await post('pair/redeem', { offerId: offer.offerId, secret: offer.secret, macId: offer.macId, fingerprint: offer.fingerprint,
        workspaceId: 1, deviceName: 'Disposable iPhone' })
    assert.equal(pending.status, 'pending')
    await service.approveDevice(pending.deviceId)
    const { credential } = await post('pair/status', { deviceId: pending.deviceId, requestToken: pending.requestToken })
    assert.equal(typeof credential, 'string')
    return {
        get service() { return service }, calls, reply, hooks, switchAway: () => { activeRuntime = null }, switchBack: () => { activeRuntime = runtime }, deviceId: pending.deviceId, origin,
        restart: async () => { await service.stop(); service = createMacPhonePairingService(options); await service.restore() },
        call: async (method = 'GET', field = '', body, { workspaceId = '1', search = query, token = credential } = {}) => {
            const path = 'workspaces/' + workspaceId + '/coworker-settings' + (field ? '/' + field : '') + search
            const response = await request(path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) })
            return { status: response.status, body: await response.json() }
        },
    }
}

test('approved read-only phones can see settings and cannot write or reach another workspace', async t => {
    const qa = await fixture(t)
    qa.reply.body = { name: 'Ada' }
    assert.deepEqual(await qa.call(), { status: 200, body: { name: 'Ada', permissions: { changeSettings: false } } })
    for (const [method, field, body] of edits) {
        assert.deepEqual(await qa.call(method, field, body), { status: 403, body: { error: 'settings_not_allowed' } })
    }
    assert.equal((await qa.call('GET', '', null, { workspaceId: '2' })).status, 404)
    assert.equal((await qa.call('GET', '', null, { token: 'A'.repeat(43) })).status, 401)
    for (const search of ['', '?agentId=.', query + '&agentId=second', query + '&workspaceId=2']) {
        assert.equal((await qa.call('GET', '', null, { search })).status, 404)
    }
    assert.equal((await qa.call('PATCH', 'secret', { password: 'fake' })).status, 404)
    assert.equal((await qa.call('DELETE', 'name', { name: 'Ada' })).status, 404)
    const view = { agentId, sessionId: target, revision: 'r4', canContinue: true }
    qa.reply.body = view
    assert.deepEqual(await qa.call('GET', 'setup'), { status: 200, body: { ...view, permissions: { changeSettings: false } } })
    assert.equal((await qa.call('GET', 'setup', null, { workspaceId: '2' })).status, 404)
    assert.equal(qa.calls.length, 2)
    await assert.rejects(qa.service.setChangeSettings(qa.deviceId, true), { code: 'not_found' })
    // A snapshot already being read cannot be released after the phone was revoked.
    const entered = Promise.withResolvers(), finish = Promise.withResolvers()
    qa.reply.hold = () => { entered.resolve(); return finish.promise }
    const reading = qa.call('GET', 'setup')
    await entered.promise
    try { await qa.service.revokeDevice(qa.deviceId) } finally { finish.resolve() }
    assert.equal((await reading).status, 401)
})

test('a paired read-only phone receives the Mac’s safe settings refusal while missing coworkers stay hidden', async t => {
    const qa = await fixture(t)
    const message = 'This workspace is switching. Wait for it to finish.'
    qa.reply.status = 409
    qa.reply.body = { error: 'settings_refused', message, internal: 'fixture detail' }
    assert.deepEqual(await qa.call(), { status: 409, body: { error: 'settings_refused', message } })
    qa.reply.status = 404
    assert.deepEqual(await qa.call(), { status: 404, body: { error: 'not_found' } })
})

test('Change settings is independent, persistent, scoped and cleared on revoke; only canonical edits and safe refusal text cross', async t => {
    const host = localPairingAddresses()[0]
    if (!host) { t.skip('no private network address for a pinned disposable phone'); return }
    const qa = await fixture(t, host)
    await qa.service.setSendMessages(qa.deviceId, true)
    await qa.service.setApproveRequests(qa.deviceId, true)
    assert.equal((await qa.call('PATCH', 'name', { name: 'Ada' })).status, 403)
    await qa.service.setSendMessages(qa.deviceId, false)
    await qa.service.setApproveRequests(qa.deviceId, false)
    await qa.service.setChangeSettings(qa.deviceId, true)
    await qa.restart()
    const [device] = await qa.service.devices()
    assert.equal(device.changeSettings, true)
    assert.equal(device.approveRequests, false)
    assert.equal(device.sendMessages, false)
    assert.equal((await qa.call()).body.permissions.changeSettings, true)
    for (const [method, field, body] of edits) {
        assert.deepEqual(await qa.call(method, field, body), { status: 200, body: { ok: true } })
        assert.deepEqual(qa.calls.at(-1), { method, url: '/api/desktop/phone-pairing/coworker-settings/' + field + query,
            body, cookie: 'rerun-desktop-session=synthetic-workspace-cookie', origin: qa.origin })
    }
    const before = qa.calls.length
    for (const [method, field, body] of edits) {
        assert.equal((await qa.call(method, field, { ...body, token: 'synthetic field' })).status, 400)
        assert.equal((await qa.call(method, field, body, { workspaceId: '2' })).status, 404)
    }
    for (const [method, field, body] of [
        ['PATCH', 'tools', { group: 'cloud', id: 'shell', enabled: true }],
        ['PATCH', 'tools', { group: 'claude', id: 'shell', enabled: true }],
        ['PATCH', 'model', { action: 'conversation', sessionId: 'x', model: 'x', connectionId: 'x' }],
        ['PATCH', 'settings', { workspaceReadEnabled: true }],
        ['PATCH', 'settings', { constructor: true }],
        ['PATCH', 'call-targets', { targetAgentIds: [] }],
        ['POST', 'box', { spaceId: target, expectedRevision: -1, requestId }],
        ['POST', 'setup', { action: 'complete', requestId, expectedRevision: 'r1' }],
        ['POST', 'setup', { action: 'continue', sessionId: target, requestId, expectedRevision: 'r1' }],
        ['POST', 'setup', { action: 'save', requestId, expectedRevision: 'r1' }],
    ]) assert.equal((await qa.call(method, field, body)).status, 400)
    assert.equal(qa.calls.length, before)
    qa.reply.status = 409
    qa.reply.body = { error: 'settings_refused', message: 'Stop this reply first.', privateReceiptField: 'never returned' }
    const edit = () => qa.call('PATCH', 'name', { name: 'Ada' })
    assert.deepEqual(await edit(), { status: 409, body: { error: 'settings_refused', message: 'Stop this reply first.' } })
    const frozen = 'This workspace is switching. Wait for it to finish.'
    qa.reply.body = { error: frozen }
    assert.deepEqual(await edit(), { status: 409, body: { error: 'settings_refused', message: frozen } })
    qa.reply.status = 403
    assert.deepEqual(await edit(), { status: 403, body: { error: 'not_allowed' } })
    qa.reply.status = 409
    for (const refusal of [{ error: frozen + ' private diagnostics' }, { error: 'raw internal detail' }, { error: 'settings_refused', message: 'a'.repeat(501) }]) {
        qa.reply.body = refusal
        assert.deepEqual(await edit(), { status: 409, body: { error: 'conflict' } })
    }
    // Turn the switch off after initial authentication, while the workspace lookup is pending.
    // Admission must read it again under the settings queue before forwarding the write.
    const disabling = Promise.withResolvers()
    qa.hooks.captured = () => qa.service.setChangeSettings(qa.deviceId, false).then(disabling.resolve, disabling.reject)
    const admittedBeforeRevoke = qa.calls.length
    assert.equal((await edit()).status, 403)
    await disabling.promise
    assert.equal(qa.calls.length, admittedBeforeRevoke)
    await qa.service.setChangeSettings(qa.deviceId, true)
    // Even a safe canonical refusal must not be released in the next workspace.
    qa.reply.hold = () => qa.switchAway()
    assert.deepEqual(await edit(), { status: 404, body: { error: 'not_found' } })
    qa.switchBack()
    await qa.service.revokeDevice(qa.deviceId)
    await qa.restart()
    assert.equal((await qa.service.devices())[0].changeSettings, false)
    assert.equal((await edit()).status, 401)
})
