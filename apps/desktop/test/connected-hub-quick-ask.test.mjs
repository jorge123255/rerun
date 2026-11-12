import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createConnectedHubQuickAsk } from '../src/main/connected-hub-quick-ask.mjs'

function fixture() {
    const windows = [], shown = [], unavailable = []
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super()
            this.options = options
            this.webContents = Object.assign(new EventEmitter(), {
                mainFrame: { url: '' },
                setWindowOpenHandler: handler => { this.open = handler },
                focus() {},
            })
            windows.push(this)
        }
        async loadURL(url) {
            this.webContents.mainFrame.url = url
            this.webContents.emit('did-navigate', {}, url, this.status ?? 200)
        }
        setAlwaysOnTop() {}
        setVisibleOnAllWorkspaces() {}
        setBounds() {}
        show() { this.visible = true }
        focus() {}
        hide() { this.visible = false }
        isDestroyed() { return this.destroyed === true }
        destroy() { this.destroyed = true; this.emit('closed') }
    }
    const app = { focus() {} }
    const screen = { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) }
    function owner(host) {
        const origin = 'https://' + host
        const contents = { session: {}, mainFrame: { url: origin + '/other' } }
        return { origin, contents, window: { loadURL: async url => { contents.mainFrame.url = url } }, scope: 'opening', available: true }
    }
    const ask = createConnectedHubQuickAsk({ app, BrowserWindow, screen, preload: 'preload',
        current: owner => owner.available, showOwner: owner => shown.push(owner), onUnavailable: owner => unavailable.push(owner) })
    return { ask, windows, shown, unavailable, first: owner('first.test'), second: owner('second.test') }
}

function sender(window) {
    return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}

test('the hosted composer is sandboxed in its opener session and only returns to the same hub', async () => {
    const { ask, windows, shown, first, second } = fixture()
    assert(ask.toggle(first.window, first))
    await Promise.resolve()
    const surface = windows[0]
    assert.equal(surface.visible, true)
    assert.equal(surface.options.webPreferences.session, first.contents.session)
    assert.equal(surface.options.webPreferences.sandbox, true)
    assert.equal(surface.options.webPreferences.nodeIntegration, false)
    assert.deepEqual(surface.open({ url: 'https://other.test' }), { action: 'deny' })
    assert.equal(ask.sender({ ...sender(surface), senderFrame: { url: first.origin + '/quick-ask' } }), null)
    const entry = ask.sender(sender(surface))
    ask.sent(entry, '//second.test/board')
    assert.equal(surface.visible, true)
    assert.deepEqual(shown, [])
    ask.sent(entry, '/board?chat=1')
    assert.equal(surface.visible, false)
    assert.deepEqual(shown, [first])
    assert.equal(first.contents.mainFrame.url, first.origin + '/board?chat=1')
    assert.equal(second.contents.mainFrame.url, second.origin + '/other')
})

test('switching hubs replaces the composer and a revoked opener cannot claim a return', async () => {
    const { ask, windows, shown, first, second } = fixture()
    ask.toggle(first.window, first)
    const firstEntry = ask.sender(sender(windows[0]))
    ask.toggle(second.window, second)
    await Promise.resolve()
    assert.equal(windows[0].isDestroyed(), true)
    assert.equal(ask.sender(sender(windows[0])), null)
    assert.equal(windows[1].options.webPreferences.session, second.contents.session)
    const secondEntry = ask.sender(sender(windows[1]))
    second.scope = 'replaced'
    ask.sent(firstEntry, '/')
    ask.sent(secondEntry, '/')
    assert.deepEqual(shown, [])
    assert.equal(ask.sender(sender(windows[1])), null)
    ask.reset(second)
    assert.equal(windows[1].isDestroyed(), true)
})
