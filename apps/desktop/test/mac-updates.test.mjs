import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { completeDesktopQuit } from '../src/main/before-quit.mjs'
import { installMacApplicationMenu } from '../src/main/application-menu.mjs'
import { verifyMacUpdateSignature } from '../src/main/mac-update-signature.mjs'
import { BUILD_RELEASE, approvedQuitAction, createMacUpdater } from '../src/main/mac-updates.mjs'

const PRODUCTION_FEED_URL = 'https://stable.fixture.invalid/rerun/desktop/stable'
const TEAM = 'ABCDE12345'
const DEV_FEED = 'https://updates.fixture.invalid/rerun/desktop/preview'

const verifiedUpdater = options => createMacUpdater({ productionFeedUrl: PRODUCTION_FEED_URL, verifySignature: () => true, ...options })

function fakeAutoUpdater() {
    const updater = new EventEmitter()
    updater.calls = []
    updater.feed = null
    updater.setFeedURL = options => {
        updater.feed = options
        updater.calls.push(['setFeedURL', options?.url ?? null])
    }
    updater.checkForUpdates = () => {
        updater.calls.push(['checkForUpdates', updater.feed?.url ?? null])
    }
    updater.quitAndInstall = () => {
        updater.calls.push(['quitAndInstall', updater.feed?.url ?? null])
    }
    return updater
}

function fakeDialog(response = 1) {
    const dialogs = []
    return {
        dialogs,
        dialog: {
            showMessageBox: async (first, second) => {
                dialogs.push(second ?? first)
                return { response }
            },
        },
    }
}

function productionRelease(overrides = {}) {
    return { packaged: true, channel: 'stable', teamId: TEAM, bundleId: 'build.rerun.desktop', feedUrl: PRODUCTION_FEED_URL, devFeedUrl: '', ...overrides }
}

function updaterFor(autoUpdater, release, extras = {}) {
    const { dialog } = fakeDialog()
    const app = { quit() {}, getVersion: () => '0.1.0', isPackaged: release.packaged === true }
    return verifiedUpdater({ autoUpdater, app, dialog, release, schedule: () => { throw new Error('disabled updater scheduled a check') }, ...extras })
}

test('no update available returns to idle and can tell the person', async () => {
    const autoUpdater = fakeAutoUpdater()
    const { dialog, dialogs } = fakeDialog()
    const app = { quit() {}, getVersion: () => '0.1.0' }
    const updates = verifiedUpdater({ autoUpdater, app, dialog, release: productionRelease(), schedule: () => { throw new Error('no timer in this test') } })
    const decision = updates.start()
    assert.equal(decision.enabled, true)
    assert.deepEqual(autoUpdater.calls, [['setFeedURL', PRODUCTION_FEED_URL]])
    autoUpdater.checkForUpdates = () => {
        autoUpdater.calls.push(['checkForUpdates', autoUpdater.feed?.url ?? null])
        autoUpdater.emit('checking-for-update')
        autoUpdater.emit('update-not-available')
    }
    await updates.checkForUpdates(true)
    assert.equal(updates.state().status, 'idle')
    assert.equal(dialogs.length, 1)
    assert.match(dialogs[0].message, /up to date/i)
    assert.match(dialogs[0].detail, /0\.1\.0/)
    assert.equal(autoUpdater.calls.filter(call => call[0] === 'quitAndInstall').length, 0)
})

test('a failed check stays safe and a later check can run', async () => {
    const autoUpdater = fakeAutoUpdater()
    const { dialog, dialogs } = fakeDialog()
    const updates = verifiedUpdater({ autoUpdater, app: { quit() {}, getVersion: () => '0.1.0' }, dialog, release: productionRelease() })
    updates.start()
    autoUpdater.checkForUpdates = () => {
        autoUpdater.emit('error', Object.assign(new Error('socket hang up'), { stack: 'hide' }))
    }
    await updates.checkForUpdates(false)
    assert.equal(updates.state().status, 'error')
    assert.match(updates.state().message, /socket hang up/)
    assert.equal(updates.state().message.includes('hide'), false)
    assert.equal(dialogs.length, 0)

    autoUpdater.checkForUpdates = () => Promise.reject(new Error(`network down ${PRODUCTION_FEED_URL}`))
    await updates.checkForUpdates(true)
    assert.equal(updates.state().status, 'error')
    assert.match(updates.state().message, /network down/)
    assert.equal(updates.state().message.includes(PRODUCTION_FEED_URL), false)
    assert.equal(dialogs.length, 1)
    assert.equal(dialogs[0].type, 'warning')

    let checks = 0
    autoUpdater.checkForUpdates = () => {
        checks += 1
        autoUpdater.emit('update-not-available')
    }
    await updates.checkForUpdates(false)
    assert.equal(checks, 1)
    assert.equal(updates.state().status, 'idle')
    assert.equal(autoUpdater.calls.filter(call => call[0] === 'quitAndInstall').length, 0)
})

test('a downloaded update restarts only after drafts are saved and services stop', async () => {
    const autoUpdater = fakeAutoUpdater()
    const order = []
    const app = { quit() {} }
    const seen = []
    const withBroadcast = verifiedUpdater({
        autoUpdater, app, dialog: fakeDialog().dialog, release: productionRelease(),
        onState: state => seen.push(state),
    })
    withBroadcast.start()
    autoUpdater.quitAndInstall = () => {
        order.push('quitAndInstall')
        autoUpdater.calls.push(['quitAndInstall', autoUpdater.feed?.url ?? null])
    }
    autoUpdater.checkForUpdates = () => { autoUpdater.emit('update-available', { version: '1.4.0' }) }
    await withBroadcast.checkForUpdates(false)
    assert.deepEqual(withBroadcast.state(), { status: 'downloading' })
    autoUpdater.emit('update-downloaded', {}, 'Signed release', '1.4.0', new Date(0), DEV_FEED)
    assert.deepEqual(withBroadcast.state(), { status: 'ready', version: '1.4.0' })
    assert.deepEqual(seen.at(-1), { status: 'ready', version: '1.4.0' })
    assert.equal(withBroadcast.menuItem().label, 'Restart to Update…')

    let quitting = false
    app.quit = () => {
        if (quitting) { order.push('app.quit'); return }
        quitting = true
        return completeDesktopQuit({
            flush: async () => { order.push('save-drafts'); return true },
            confirmDiscard: async () => { order.push('confirm-discard'); return false },
            stop: async () => { order.push('shutdown-services') },
            quit: () => {
                order.push('approved-quit')
                approvedQuitAction(withBroadcast, app)
            },
        })
    }
    assert.equal(await withBroadcast.requestRestart(), true)
    assert.deepEqual(order, ['save-drafts', 'shutdown-services', 'approved-quit', 'quitAndInstall'])
    assert.equal(autoUpdater.calls.filter(call => call[0] === 'quitAndInstall').length, 1)
    assert.equal(order.indexOf('quitAndInstall') > order.indexOf('shutdown-services'), true)
    assert.equal(order.indexOf('shutdown-services') > order.indexOf('save-drafts'), true)
})

test('a cancelled quit does not install and a later restart does', async () => {
    const autoUpdater = fakeAutoUpdater()
    const order = []
    let saved = false
    let discard = false
    let quitting = false
    const app = { quit() {} }
    const updates = verifiedUpdater({ autoUpdater, app, dialog: fakeDialog(0).dialog, release: productionRelease() })
    updates.start()
    autoUpdater.quitAndInstall = () => {
        order.push('quitAndInstall')
        autoUpdater.calls.push(['quitAndInstall', autoUpdater.feed?.url ?? null])
    }
    autoUpdater.checkForUpdates = () => { autoUpdater.emit('update-downloaded', {}, '', '2.0.0') }
    await updates.checkForUpdates(false)
    assert.equal(updates.state().status, 'ready')

    app.quit = () => {
        if (quitting) { order.push('app.quit'); return }
        quitting = true
        return completeDesktopQuit({
            flush: async () => { order.push('save-drafts'); return saved },
            confirmDiscard: async () => { order.push('confirm-discard'); return discard },
            stop: async () => { order.push('shutdown-services') },
            quit: () => {
                order.push('approved-quit')
                approvedQuitAction(updates, app)
            },
            cancelled: () => { order.push('cancelled'); quitting = false },
        })
    }

    assert.equal(await updates.requestRestart(), true)
    assert.deepEqual(order, ['save-drafts', 'confirm-discard', 'cancelled'])
    assert.equal(autoUpdater.calls.some(call => call[0] === 'quitAndInstall'), false)
    assert.deepEqual(updates.state(), { status: 'ready', version: '2.0.0' })

    saved = true
    assert.equal(await updates.requestRestart(), true)
    assert.deepEqual(order, ['save-drafts', 'confirm-discard', 'cancelled', 'save-drafts', 'shutdown-services', 'approved-quit', 'quitAndInstall'])
    assert.equal(autoUpdater.calls.filter(call => call[0] === 'quitAndInstall').length, 1)
})

test('unpackaged, dev, preview, unsigned, and feedless builds never touch a production feed', async () => {
    const previousUrl = process.env.RERUN_DESKTOP_UPDATE_URL
    const previousTest = process.env.RERUN_DESKTOP_UPDATE_TEST
    process.env.RERUN_DESKTOP_UPDATE_URL = PRODUCTION_FEED_URL
    process.env.RERUN_DESKTOP_UPDATE_TEST = '1'
    try {
        const blocked = [
            { packaged: false, channel: 'stable', teamId: TEAM, feedUrl: PRODUCTION_FEED_URL },
            { packaged: true, channel: 'dev', teamId: TEAM, feedUrl: PRODUCTION_FEED_URL },
            { packaged: true, channel: 'preview', teamId: TEAM, feedUrl: PRODUCTION_FEED_URL, devFeedUrl: PRODUCTION_FEED_URL },
            { packaged: true, channel: 'internal', teamId: TEAM, feedUrl: PRODUCTION_FEED_URL },
            { packaged: true, channel: 'stable', teamId: '', feedUrl: PRODUCTION_FEED_URL },
            { packaged: true, channel: 'stable', teamId: 'development', feedUrl: PRODUCTION_FEED_URL },
            { packaged: true, channel: 'stable', teamId: TEAM, feedUrl: '' },
            { ...BUILD_RELEASE, packaged: true },
        ]
        for (const release of blocked) {
            const autoUpdater = fakeAutoUpdater()
            const updates = updaterFor(autoUpdater, release)
            updates.start({ scheduleChecks: true })
            await updates.checkForUpdates(true, { feedUrl: PRODUCTION_FEED_URL })
            const productionUse = autoUpdater.calls.filter(call => call[1] === PRODUCTION_FEED_URL || (call[0] === 'checkForUpdates' && call[1] === PRODUCTION_FEED_URL))
            assert.deepEqual(productionUse, [], JSON.stringify(release))
            assert.equal(autoUpdater.calls.some(call => call[0] === 'setFeedURL'), false, JSON.stringify(release))
            assert.equal(autoUpdater.calls.some(call => call[0] === 'checkForUpdates'), false, JSON.stringify(release))
        }

        const autoUpdater = fakeAutoUpdater()
        const updates = updaterFor(autoUpdater, productionRelease({
            channel: 'preview',
            feedUrl: PRODUCTION_FEED_URL,
            devFeedUrl: DEV_FEED,
        }))
        updates.start()
        autoUpdater.checkForUpdates = () => { autoUpdater.calls.push(['checkForUpdates', autoUpdater.feed?.url ?? null]) }
        await updates.checkForUpdates(false)
        assert.deepEqual(autoUpdater.calls, [
            ['setFeedURL', DEV_FEED],
            ['checkForUpdates', DEV_FEED],
        ])
        assert.equal(autoUpdater.calls.some(call => call[1] === PRODUCTION_FEED_URL), false)

        const loopback = fakeAutoUpdater()
        const local = updaterFor(loopback, productionRelease({ channel: 'dev', feedUrl: PRODUCTION_FEED_URL, devFeedUrl: 'http://127.0.0.1:9/feed' }))
        local.start()
        assert.deepEqual(loopback.calls, [['setFeedURL', 'http://127.0.0.1:9/feed']])

        const remoteHttp = fakeAutoUpdater()
        const rejected = updaterFor(remoteHttp, productionRelease({ channel: 'dev', devFeedUrl: 'http://updates.fixture.invalid/preview' }))
        rejected.start()
        await rejected.checkForUpdates(false)
        assert.deepEqual(remoteHttp.calls, [])
    } finally {
        if (previousUrl === undefined) delete process.env.RERUN_DESKTOP_UPDATE_URL
        else process.env.RERUN_DESKTOP_UPDATE_URL = previousUrl
        if (previousTest === undefined) delete process.env.RERUN_DESKTOP_UPDATE_TEST
        else process.env.RERUN_DESKTOP_UPDATE_TEST = previousTest
    }
})

test('the application menu and preload expose check and restart without a feed argument', async () => {
    let menu
    const Menu = { buildFromTemplate: template => template, setApplicationMenu: value => { menu = value } }
    const clicks = []
    installMacApplicationMenu({
        Menu, appName: 'Rerun', settingsWindow: () => null, isDesktopPage: () => false,
        openDocumentation() {}, openFind() {}, openNewWindow() {}, openHubPicker() {}, reloadWindow() {},
        checkForUpdates: () => clicks.push('check'),
        updateItem: { label: 'Downloading Update… 10%', enabled: false },
    })
    const item = menu[0].submenu.find(entry => entry.id === 'rerun-check-for-updates')
    assert.equal(item.label, 'Downloading Update… 10%')
    assert.equal(item.enabled, false)
    item.click()
    assert.deepEqual(clicks, [])

    const ipcRenderer = new EventEmitter()
    const invoked = []
    ipcRenderer.invoke = (channel, ...args) => { invoked.push([channel, args]); return Promise.resolve({ status: 'idle' }) }
    const source = await readFile(new URL('../src/main/preload.cjs', import.meta.url), 'utf8')
    let desktopApp
    const contextBridge = { exposeInMainWorld: (name, api) => { if (name === 'desktopApp') desktopApp = api } }
    runInNewContext(source, { process: { platform: 'darwin' }, require: () => ({ contextBridge, ipcRenderer }) })
    const heard = []
    const stop = desktopApp.updates.onState(state => heard.push(state))
    ipcRenderer.emit('desktop:update-state', { sender: 'privileged' }, { status: 'ready', version: '9.0.0' })
    assert.deepEqual(heard, [{ status: 'ready', version: '9.0.0' }])
    await desktopApp.updates.check()
    await desktopApp.updates.install()
    assert.deepEqual(invoked.map(entry => entry[0]), ['desktop:update-check', 'desktop:update-install'])
    assert.deepEqual(invoked[0][1], [])
    stop()
    ipcRenderer.emit('desktop:update-state', {}, { status: 'idle' })
    assert.equal(heard.length, 1)
})

test('a configured team cannot open a feed without the running bundle signature', async () => {
    const autoUpdater = fakeAutoUpdater()
    const calls = []
    const updates = verifiedUpdater({ autoUpdater, app: {}, release: productionRelease(),
        verifySignature: (_app, requirement) => { calls.push(requirement); return false } })
    assert.equal(updates.start({ scheduleChecks: true }).reason, 'signature')
    await updates.checkForUpdates(false)
    assert.deepEqual(autoUpdater.calls, [])
    assert.deepEqual(calls, [{ teamId: TEAM, bundleId: 'build.rerun.desktop', production: true }])
})

test('macOS verifies the running app bundle against Apple, its team and Developer ID', () => {
    const app = { getPath: () => '/tmp/Rerun QA.app/Contents/MacOS/Rerun QA' }
    const pin = { teamId: TEAM, bundleId: 'build.rerun.desktop', production: true }
    const commands = []
    assert.equal(verifyMacUpdateSignature(app, pin, (...args) => { commands.push(args); return { status: 0 } }), true)
    const [cmd, argv] = commands[0]
    assert.equal(cmd, '/usr/bin/codesign')
    assert.deepEqual(argv.slice(0, 3), ['--verify', '--strict', '--test-requirement'])
    assert.match(argv[3], /^=anchor apple generic and identifier "build\.rerun\.desktop"/)
    assert.match(argv[3], /certificate leaf\[subject\.OU\] = "ABCDE12345"/)
    assert.match(argv[3], /1\.2\.840\.113635\.100\.6\.1\.13/)
    assert.equal(argv[4], '/tmp/Rerun QA.app')
    assert.equal(verifyMacUpdateSignature(app, pin, () => ({ status: 1 })), false)
    assert.equal(verifyMacUpdateSignature(app, { ...pin, bundleId: 'injected"req' }, () => assert.fail('invalid bundle id')), false)
    assert.equal(verifyMacUpdateSignature({ getPath: () => '/tmp/Electron' }, pin, () => assert.fail('not an app bundle')), false)
})
