import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createHubRecovery } from '../src/main/connected-hub-recovery.mjs'

const origin = 'https://hub.example.test'
const offlinePage = new URL('file:///staged/connected-hub-offline.html')

function fixture(check = async () => ({ ok: true }), now, abortDuringNavigation = false) {
    const contents = Object.assign(new EventEmitter(), { mainFrame: { url: origin + '/' } })
    const loads = []
    let code = 200, destroyed = false, invalidations = 0, dispatching = false, aborted = false
    let recoveryLoaded
    const loaded = new Promise(resolve => { recoveryLoaded = resolve })
    const window = Object.assign(new EventEmitter(), {
        webContents: contents,
        isDestroyed: () => destroyed,
        async loadURL(url) {
            loads.push(url)
            if (abortDuringNavigation && dispatching) {
                aborted = true
                return
            }
            contents.mainFrame.url = url
            dispatching = true
            contents.emit('did-navigate', {}, url, code)
            dispatching = false
            if (url === offlinePage.href) recoveryLoaded()
            if (aborted) throw new Error('ERR_ABORTED')
        },
    })
    const hub = createHubRecovery({ window, origin, offlinePage, available: () => true, check, invalidate: () => invalidations++, now })
    return { hub, loads, loaded, contents, invalidations: () => invalidations, setCode: value => { code = value },
        close() { destroyed = true; window.emit('closed') } }
}

test('a first 503 loads recovery after the board navigation settles and retry opens the exact route', async () => {
    const f = fixture(undefined, undefined, true)
    f.setCode(503)
    const target = origin + '/board?workspace=1#chat'
    assert(await f.hub.navigate(target))
    assert.deepEqual(f.hub.state(), { host: 'hub.example.test', reason: 'unavailable' })
    assert(f.hub.onOfflinePage())
    f.setCode(200)
    assert.equal(await f.hub.retry(), null)
    assert.equal(f.contents.mainFrame.url, target)
    assert.deepEqual(f.loads, [target, offlinePage.href, target])
})

test('a main-frame connection failure keeps the exact route for same-hub retry', async () => {
    const f = fixture()
    const target = origin + '/board?workspace=1#chat'
    f.contents.emit('did-fail-load', {}, -102, '', target, true)
    await f.loaded
    assert(f.hub.onOfflinePage())
    assert.equal(f.hub.state().reason, 'offline')
    assert.equal(f.invalidations(), 1)
})

test('a renderer crash reopens the last committed route and a repeated crash requires explicit retry', async () => {
    let now = 0
    const { hub, contents, loads, loaded, invalidations, close } = fixture(undefined, () => now)
    const route = origin + '/board?workspace=7#coworker'
    contents.emit('did-navigate-in-page', {}, route, true)
    contents.emit('render-process-gone', {}, { reason: 'clean-exit' })
    assert.deepEqual(loads, [])
    contents.emit('render-process-gone', {}, { reason: 'crashed' })
    assert.deepEqual(loads, [route])
    assert.equal(hub.state(), null)
    now += 5000
    contents.emit('render-process-gone', {}, { reason: 'oom' })
    await loaded
    assert.deepEqual(loads, [route, offlinePage.href])
    assert.equal(hub.state().reason, 'renderer-crashed')
    assert.equal(hub.onOfflinePage(), true)
    assert.equal(await hub.retry(), null)
    assert.deepEqual(loads, [route, offlinePage.href, route])
    now += 60_000
    contents.emit('render-process-gone', {}, { reason: 'killed' })
    assert.equal(loads.at(-1), route)
    assert.equal(invalidations(), 4)
    close()
    contents.emit('render-process-gone', {}, { reason: 'crashed' })
    assert.equal(loads.length, 4)
})

test('downloads, foreign destinations, and subframe failures cannot switch the hub to recovery', async () => {
    const { hub, contents, loads } = fixture()
    const path = origin + '/board#draft'
    contents.emit('did-navigate-in-page', {}, path, true)
    contents.emit('did-navigate-in-page', {}, origin + '/embedded', false)
    contents.emit('did-fail-load', {}, -3, '', origin + '/export', true)
    contents.emit('did-fail-load', {}, -105, '', 'https://other.test/', true)
    contents.emit('did-fail-load', {}, -105, '', origin + '/subframe', false)
    assert.equal(hub.target(), path)
    assert.equal(hub.state(), null)
    assert.equal(await hub.navigate('https://other.test/'), false)
    assert.deepEqual(loads, [])
})

test('retry coalesces concurrent requests, keeps incompatible hubs offline, and aborts on close', async () => {
    let finish, signal, checks = 0
    const { hub, close, loads } = fixture(input => {
        checks++
        signal = input
        return new Promise(resolve => { finish = resolve })
    })
    assert(await hub.showOffline(origin + '/', 'offline'))
    const first = hub.retry()
    assert.equal(hub.retry(), first)
    assert.equal(checks, 1)
    finish({ ok: false, reason: 'too-old', minimum: '1.0.0' })
    assert.deepEqual(await first, { host: 'hub.example.test', reason: 'too-old', minimum: '1.0.0' })
    const second = hub.retry()
    close()
    assert.equal(signal.aborted, true)
    finish({ ok: true })
    assert.equal(await second, null)
    assert.deepEqual(loads, [offlinePage.href])
})

test('a saved server requiring an update stays on its local recovery page until a compatible check', async () => {
    let result = { ok: false, reason: 'unreachable' }
    const { hub, loads, contents } = fixture(async () => result)
    const target = origin + '/board'
    assert(await hub.showOffline(target, 'too-old', '7.2.1'))
    assert(await hub.showOffline(target, 'too-old', '7.2.1'))
    assert.deepEqual(await hub.retry(), { host: 'hub.example.test', reason: 'too-old', minimum: '7.2.1' })
    assert.deepEqual(loads, [offlinePage.href])
    result = { ok: true }
    assert.equal(await hub.retry(), null)
    assert.equal(contents.mainFrame.url, target)
    assert.deepEqual(loads, [offlinePage.href, target])
})
