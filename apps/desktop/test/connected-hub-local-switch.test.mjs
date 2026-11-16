import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { attachLocalSwitch, localSwitchBounds, localSwitchPage } from '../src/main/connected-hub-local-switch.mjs'

function fakes(width = 1280) {
    const contents = Object.assign(new EventEmitter(), { loaded: null, opener: null, closed: false,
        loadURL(url) { this.loaded = url; return Promise.resolve() }, setWindowOpenHandler(handler) { this.opener = handler }, isDestroyed: () => false, close() { this.closed = true } })
    const views = []
    class WebContentsView { constructor(options) { this.options = options; this.webContents = contents; this.visible = true; views.push(this) } setBackgroundColor() {} setBounds(bounds) { this.bounds = bounds } setVisible(value) { this.visible = value } }
    const children = []
    const window = Object.assign(new EventEmitter(), { width, isDestroyed: () => false, getContentBounds() { return { width: this.width, height: 800 } },
        contentView: { addChildView: view => children.push(view), removeChildView: view => children.splice(children.indexOf(view), 1) } })
    return { WebContentsView, window, contents, views, children }
}

test('the button is a sandboxed view with no script, centred above the page and clear of the traffic lights', () => {
    const f = fakes()
    attachLocalSwitch({ ...f, label: 'This Mac', onOpen() {} })
    assert.equal(f.children.length, 1)
    assert.deepEqual(f.views[0].options.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, partition: 'rerun-local-switch' })
    assert.deepEqual(f.views[0].bounds, { x: 574, y: 5, width: 132, height: 26 })
    assert.ok(localSwitchBounds(460).x >= 96)
    f.window.width = 900; f.window.emit('resize')
    assert.equal(f.views[0].bounds.x, 384)
    const page = decodeURIComponent(f.contents.loaded)
    assert.match(page, /default-src 'none'/)
    assert.doesNotMatch(page, /<script/)
})

test('a click opens the local workspace and nothing else is ever loaded or opened', () => {
    const f = fakes(), opened = []
    attachLocalSwitch({ ...f, label: 'This Mac', onOpen: () => opened.push('local') })
    const go = url => { const event = { prevented: false, preventDefault() { this.prevented = true } }; f.contents.emit('will-navigate', event, url); return event.prevented }
    assert.equal(go('rerun-local://open'), true)
    assert.equal(go('https://example.com/'), true)
    assert.deepEqual(opened, ['local'])
    assert.deepEqual(f.contents.opener(), { action: 'deny' })
})

test('the label is written as text, the button hides for a full-screen page, and detaching removes it', () => {
    assert.match(decodeURIComponent(localSwitchPage('<b>Mac</b>')), /&lt;b&gt;Mac&lt;\/b&gt;/)
    const f = fakes()
    const detach = attachLocalSwitch({ ...f, label: 'This Mac', onOpen() {} })
    f.window.emit('enter-html-full-screen'); assert.equal(f.views[0].visible, false)
    f.window.emit('leave-html-full-screen'); assert.equal(f.views[0].visible, true)
    detach()
    assert.equal(f.children.length, 0)
    assert.equal(f.contents.closed, true)
    // A window with no content view (an older shell) is left alone.
    assert.doesNotThrow(() => attachLocalSwitch({ WebContentsView: f.WebContentsView, window: {}, label: 'x', onOpen() {} })())
})
