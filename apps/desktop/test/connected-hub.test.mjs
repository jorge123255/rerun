import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { checkHub, hubPartition, hubWindowAddress, isPublishedPageHandoff, normalizeHubOrigin, parseHubLink, registerHubProtocol, sameHub } from '../src/main/connected-hub-policy.mjs'
import { createHubAuth } from '../src/main/connected-hub-auth.mjs'

const origin = 'https://hub.example.test'
const code = 'A'.repeat(43)

test('an explicit hub address uses HTTPS or HTTP on loopback and has its own partition', () => {
    assert.equal(normalizeHubOrigin('hub.example.test/path'), origin)
    assert.equal(normalizeHubOrigin('hub.example.test:4443'), origin + ':4443')
    assert.equal(normalizeHubOrigin('http://127.0.0.1:8371'), 'http://127.0.0.1:8371')
    assert.equal(normalizeHubOrigin('http://[::1]:8371'), 'http://[::1]:8371')
    for (const address of ['http://hub.example.test', 'http://localhost.other.test', 'https://a:b@hub.example.test', 'file:///tmp/hub',
        'javascript:', '//hub.example.test', 'https://hub.example.test\\foo', 'https://hub.example.test\n/path']) {
        assert.equal(normalizeHubOrigin(address), null, address)
    }
    assert.notEqual(hubPartition(origin), hubPartition(origin + ':4443'))
    assert.notEqual(hubPartition('http://127.0.0.1:8371'), hubPartition('http://127.0.0.1:8372'))
    assert.equal(sameHub('blob:' + origin + '/uuid', origin), false)
    assert.equal(sameHub(origin + '/boards', origin), true)
})

test('the bounded config check refuses bad identities, incompatible releases and redirects', async () => {
    const fixture = { app: 'rerun', apiVersion: 1, minShellVersion: '0.1.0' }
    const check = (config, installed = '0.1.0') => checkHub(origin, installed, async (url, options) => {
        assert.equal(url, origin + '/api/desktop/config')
        assert.equal(options.credentials, 'omit')
        assert.equal(options.redirect, 'error')
        return Response.json(config)
    })
    assert.deepEqual(await check(fixture), { ok: true })
    assert.deepEqual(await check(fixture, '0.1.0-dev'), { ok: false, reason: 'too-old', minimum: '0.1.0' })
    assert.deepEqual(await check({ ...fixture, apiVersion: 2 }), { ok: false, reason: 'unsupported' })
    assert.deepEqual(await check({ ...fixture, app: 'other' }), { ok: false, reason: 'not-rerun' })
    assert.deepEqual(await check({ ...fixture, padding: 'x'.repeat(5000) }), { ok: false, reason: 'not-rerun' })
    assert.deepEqual(await checkHub(origin, '0.1.0', async () => new Response(null, { status: 302 })), { ok: false, reason: 'not-rerun' })
})

test('only the exact published-page gate can hand a signed ticket URL to the browser', () => {
    const source = origin + '/published-auth?slug=fixture'
    const target = 'https://published.fixture.test/__rerun/auth?ticket=fixture_body.fixture_signature&next=%2Fnotes'
    assert.equal(isPublishedPageHandoff(source, target, origin), true)
    for (const address of [
        target.replace('https:', 'http:'),
        target.replace('https://', 'https://user@'),
        target.replace('/__rerun/auth', '/other'),
        target.replace('fixture_body.fixture_signature', 'unsigned'),
        target + '&ticket=another.value',
        'file:///__rerun/auth?ticket=fixture_body.fixture_signature',
    ]) assert.equal(isPublishedPageHandoff(source, address, origin), false, address)
    assert.equal(isPublishedPageHandoff(origin + '/preview', target, origin), false)
    assert.equal(isPublishedPageHandoff('https://foreign.test/published-auth', target, origin), false)
})

test('development links carry only the exact callback or a same-server path', () => {
    const state = 'B'.repeat(32)
    const callback = `rerun-desktop-dev://auth/callback?code=${code}&state=${state}`
    assert.deepEqual(parseHubLink(callback), { kind: 'auth', code, state })
    assert.equal(parseHubLink(callback + '&code=' + code), null)
    assert.equal(parseHubLink(callback.replace('-dev', '')), null)
    assert.equal(parseHubLink(callback.replace('auth/', 'user@auth/')), null)
    assert.deepEqual(parseHubLink('rerun-desktop-dev://open?path=%2Fboard%3Fworkspace%3D1'), { kind: 'open', path: '/board?workspace=1' })
    for (const path of ['//outside.test', '/\\outside.test', 'https://outside.test', '/board\n']) {
        assert.equal(parseHubLink('rerun-desktop-dev://open?path=' + encodeURIComponent(path)), null)
    }
})

test('the packaged Mac preview registers its declared development scheme without touching the stable scheme', async () => {
    const packaging = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
    assert.match(packaging, /protocols:\s+- name: Rerun Development Links\s+schemes:\s+- rerun-desktop-dev(?:\s|$)/)
    const calls = []
    let alreadyDefault = false
    const app = { isPackaged: false, isDefaultProtocolClient: scheme => { calls.push(['get', scheme]); return alreadyDefault },
        setAsDefaultProtocolClient: scheme => { calls.push(['set', scheme]); return true } }
    assert.equal(registerHubProtocol(app), false)
    assert.deepEqual(calls, [])
    app.isPackaged = true
    assert.equal(registerHubProtocol(app), true)
    alreadyDefault = true
    assert.equal(registerHubProtocol(app), true)
    assert.deepEqual(calls, [['get', 'rerun-desktop-dev'], ['set', 'rerun-desktop-dev'], ['get', 'rerun-desktop-dev']])
    app.isDefaultProtocolClient = () => { throw new Error('Launch Services refused') }
    assert.equal(registerHubProtocol(app), false)
})

test('a new hub window preserves the page and existing workspace or adds the originating tab pin', () => {
    assert.equal(hubWindowAddress(origin + '/board?label=a%20b#chat', origin, '7'), origin + '/board?label=a%20b&workspace=7#chat')
    assert.equal(hubWindowAddress(origin + '/board?workspace=9#chat', origin, '7'), origin + '/board?workspace=9#chat')
    assert.equal(hubWindowAddress(origin + '/board', origin, '-1'), origin + '/board')
    assert.equal(hubWindowAddress('https://other.test/board', origin, '7'), null)
})

test('browser sign-in uses PKCE and exchanges a matching state once on its own hub', async () => {
    let opened, exchanges = 0
    const auth = createHubAuth({ origin, openBrowser: async url => { opened = new URL(url) }, fetcher: async (url, request) => {
        exchanges++
        assert.equal(url, origin + '/api/desktop/auth/exchange')
        assert.equal(request.redirect, 'error')
        assert.equal(request.credentials, 'include')
        const payload = JSON.parse(request.body)
        assert.equal(payload.code, code)
        assert.equal(createHash('sha256').update(payload.verifier).digest('base64url'), opened.searchParams.get('challenge'))
        return Response.json({ ok: true })
    } })
    await auth.start('google')
    assert.equal(opened.origin, origin)
    assert.equal(opened.pathname, '/auth/desktop')
    assert.equal(opened.searchParams.get('provider'), 'google')
    assert.equal(opened.searchParams.get('channel'), 'dev')
    assert.equal(opened.searchParams.has('verifier'), false)
    assert.deepEqual(await auth.redeem(code, 'B'.repeat(32)), { status: 'error', reason: 'state-mismatch' })
    assert.equal(exchanges, 0)
    assert.deepEqual(await auth.redeem(code, opened.searchParams.get('state')), { status: 'signed-in' })
    assert.deepEqual(await auth.redeem(code), { status: 'error', reason: 'expired' })
    assert.equal(exchanges, 1)
})

test('an expired or cancelled browser exchange cannot report sign-in, and paste needs a pending attempt', async () => {
    let time = 0, response, signal, requests = 0
    const auth = createHubAuth({ origin, now: () => time, openBrowser: async () => {}, fetcher: (_url, init) => {
        signal = init.signal
        requests++
        return new Promise(resolve => { response = resolve })
    } })
    assert.deepEqual(await auth.redeem(code), { status: 'error', reason: 'expired' })
    await auth.start()
    time = 16 * 60_000
    assert.deepEqual(await auth.redeem(code), { status: 'error', reason: 'expired' })
    assert.equal(requests, 0)
    await auth.start()
    const exchange = auth.redeem(code)
    await assert.rejects(auth.start(), /finishing/)
    auth.cancel()
    assert.equal(signal.aborted, true)
    response(Response.json({ ok: true }))
    assert.deepEqual(await exchange, { status: 'error', reason: 'expired' })
})

test('the hub preload exposes only its approved audience and drops the privileged event', async () => {
    const source = await readFile(new URL('../src/main/connected-hub-preload.cjs', import.meta.url), 'utf8')
    function bootstrap(value) {
        const exposed = {}, listeners = new Map(), requests = []
        const ipcRenderer = { sendSync: () => value, on: (channel, fn) => listeners.set(channel, fn),
            removeListener: channel => listeners.delete(channel), invoke: async (...args) => { requests.push(args); return false } }
        const contextBridge = { exposeInMainWorld: (name, api) => { exposed[name] = api } }
        runInNewContext(source, { require: () => ({ ipcRenderer, contextBridge }), sessionStorage: { getItem: () => '7' } })
        return { exposed, listeners, requests }
    }
    assert.deepEqual(Object.keys(bootstrap(null).exposed), [])
    const picker = bootstrap({ audience: 'picker' })
    assert.deepEqual(Object.keys(picker.exposed), ['rerunHubPicker'])
    assert.equal(picker.exposed.rerunHubPicker.appearance, null)
    for (const appearance of ['light', 'dark']) {
        assert.equal(bootstrap({ audience: 'picker', appearance }).exposed.rerunHubPicker.appearance, appearance)
    }
    assert.equal(bootstrap({ audience: 'picker', appearance: 'unrecognized' }).exposed.rerunHubPicker.appearance, null)
    await picker.exposed.rerunHubPicker.initialOrigin()
    await picker.exposed.rerunHubPicker.cancel('https://wrong.example.test')
    await picker.exposed.rerunHubPicker.connectCloud('https://wrong.example.test')
    assert.deepEqual(picker.requests, [['hub:picker-origin'], ['hub:picker-cancel'], ['hub:connect-cloud']])
    const offline = bootstrap({ audience: 'hub-offline' })
    assert.deepEqual(Object.keys(offline.exposed), ['rerunHubOffline'])
    assert.equal(offline.exposed.rerunHubOffline.appearance, 'dark')
    assert.equal(bootstrap({ audience: 'hub-offline', appearance: 'light' }).exposed.rerunHubOffline.appearance, 'light')
    assert.equal(bootstrap({ audience: 'hub-offline', appearance: 'unrecognized' }).exposed.rerunHubOffline.appearance, 'dark')
    await offline.exposed.rerunHubOffline.state()
    await offline.exposed.rerunHubOffline.retry()
    await offline.exposed.rerunHubOffline.changeServer('https://ignored.example')
    await offline.exposed.rerunHubOffline.download('https://ignored.example')
    assert.deepEqual(offline.requests, [['hub:offline-state'], ['hub:offline-retry'], ['hub:offline-change-server'], ['hub:offline-download']])
    assert.equal(offline.exposed.rerunHubOffline.update, undefined)
    const store = bootstrap({ audience: 'hub-offline', appStore: true })
    assert.equal(store.exposed.rerunHubOffline.appStore, true)
    assert.equal(store.exposed.rerunHubOffline.download, undefined)
    const recoveryUpdate = bootstrap({ audience: 'hub-offline', updatesAvailable: true })
    const recoveryUpdater = recoveryUpdate.exposed.rerunHubOffline.update
    await recoveryUpdater.getState()
    await recoveryUpdater.check('https://ignored.example')
    await recoveryUpdater.install('untrusted-version')
    assert.deepEqual(recoveryUpdate.requests, [['hub:offline-update-state'], ['hub:offline-update-check'], ['hub:offline-update-install']])
    const { exposed, listeners } = bootstrap({ audience: 'hub', capabilities: ['auth'] })
    assert.deepEqual(Object.keys(exposed), ['rerunShell'])
    const seen = []
    const unsubscribe = exposed.rerunShell.auth.onResult((...args) => seen.push(args))
    listeners.get('hub:auth-result')({ sender: 'privileged' }, { status: 'signed-in' })
    assert.deepEqual(seen, [[{ status: 'signed-in' }]])
    unsubscribe()
    assert.equal(listeners.size, 0)
    const chrome = bootstrap({ audience: 'hub', capabilities: ['window'] })
    chrome.exposed.rerunShell.window.setChrome({ frameColor: '#00000000', symbolColor: '#0a0a0a', appearance: 'dark' })
    assert.deepEqual(JSON.parse(JSON.stringify(chrome.requests)),
        [['hub:window-chrome', { frameColor: '#00000000', symbolColor: '#0a0a0a' }]])
    const native = bootstrap({ audience: 'hub', capabilities: ['notifications', 'badge'] })
    const notice = { id: 'task:123', title: 'Finished' }
    const clicks = []
    native.exposed.rerunShell.notifications.onClick((...args) => clicks.push(args))
    native.listeners.get('hub:notification-click')({ sender: 'privileged' }, notice.id)
    assert.deepEqual(clicks, [[notice.id]])
    assert.equal(await native.exposed.rerunShell.notifications.show(notice), false)
    native.exposed.rerunShell.badge.set(2)
    assert.deepEqual(native.requests, [['hub:notify', notice], ['hub:badge', 2, '7']])
    assert.equal(native.exposed.rerunShell.update, undefined)
    const updating = bootstrap({ audience: 'hub', capabilities: ['update'] })
    const updater = updating.exposed.rerunShell.update
    const states = []
    const stop = updater.onState((...args) => states.push(args))
    updating.listeners.get('hub:update-state')({ sender: 'privileged' }, { status: 'ready', version: '2.0.0' })
    assert.deepEqual(states, [[{ status: 'ready', version: '2.0.0' }]])
    await updater.getState()
    updater.check('https://foreign.test')
    updater.install('https://foreign.test')
    assert.deepEqual(updating.requests, [['hub:update-state'], ['hub:update-check'], ['hub:update-install']])
    stop()
    assert.equal(updating.listeners.size, 0)
    const quickAsk = bootstrap({ audience: 'hub-quick-ask', shortcut: 'CommandOrControl+Shift+Space' })
    const composer = quickAsk.exposed.rerunShell
    assert.deepEqual(Array.from(composer.capabilities), ['quickAsk'])
    assert.equal(composer.settings, undefined)
    assert.equal(composer.auth, undefined)
    composer.quickAsk.sent('/board')
    composer.quickAsk.close()
    assert.deepEqual(quickAsk.requests, [['hub:quick-ask-sent', '/board'], ['hub:quick-ask-close']])
})
