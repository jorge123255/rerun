import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createHubPaymentWindows } from '../src/main/connected-hub-payment.mjs'

const origin = 'https://workspace.example.test'
const checkout = 'https://checkout.stripe.com/c/pay'
const connect = 'https://connect.stripe.com/setup'

function fixture(enabled = true) {
    const windows = [], shown = [], returns = []
    const entry = {
        origin, scope: 'workspace-document', window: { isFocused: () => true },
        contents: { mainFrame: { url: origin + '/templates' }, session: {} },
        recovery: { navigate: async url => returns.push(url) },
    }
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super()
            this.options = options
            this.webContents = Object.assign(new EventEmitter(), {
                mainFrame: {},
                setWindowOpenHandler: handler => { this.openPopup = handler },
            })
            windows.push(this)
        }
        isDestroyed() { return !!this.destroyed }
        destroy() { this.destroyed = true; this.emit('closed') }
        async loadURL(url) { this.url = url }
    }
    const payments = createHubPaymentWindows({ BrowserWindow, enabled, show: window => shown.push(window),
        isCurrent: candidate => candidate === entry })
    const navigate = (window, url, details = {}, name = 'will-redirect') => {
        const event = { url, isMainFrame: true, preventDefault() { this.prevented = true }, ...details }
        window.webContents.emit(name, event)
        return event.prevented === true
    }
    return { entry, payments, windows, shown, returns, navigate }
}

test('direct builds admit only the two exact Stripe HTTPS origins from the focused connected workspace', () => {
    const { entry, payments, windows, shown } = fixture()
    for (const invalid of [
        'http://checkout.stripe.com/pay', 'https://checkout.stripe.com:444/pay',
        'https://checkout.stripe.com.attacker.test/pay', 'https://name@checkout.stripe.com/pay',
        'file:///tmp/checkout.stripe.com', 'not a url',
    ]) assert.equal(payments.open(entry, invalid), false)
    assert.equal(payments.open({ ...entry }, checkout), false)
    assert.equal(windows.length, 0)
    assert.equal(payments.open(entry, checkout), true)
    const [child] = windows
    assert.equal(child.options.parent, entry.window)
    assert.deepEqual(child.options.webPreferences, {
        session: entry.contents.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    })
    assert.deepEqual(child.openPopup(), { action: 'deny' })
    assert.equal(child.url, checkout)
    assert.equal(payments.open(entry, checkout), true)
    assert.equal(windows.length, 1)
    assert.deepEqual(shown, [child])
    assert.equal(payments.open(entry, connect), true)
    assert.equal(child.isDestroyed(), true)
    child.emit('ready-to-show')
    assert.equal(windows[1].isDestroyed(), false)
    const store = fixture(false)
    assert.equal(store.payments.open(store.entry, checkout), false)
    assert.equal(store.windows.length, 0)
})

test('only the current payment document can return to its own workspace', () => {
    const { entry, payments, windows, shown, returns, navigate } = fixture()
    assert.equal(payments.open(entry, checkout), true)
    const [child] = windows
    const returned = origin + '/templates?workspace=1'
    assert.equal(navigate(child, connect), false)
    assert.equal(navigate(child, 'https://other-workspace.example.test/'), true)
    assert.equal(navigate(child, returned, { isMainFrame: false }), false)
    assert.equal(navigate(child, returned, { initiator: {} }), true)
    assert.deepEqual(returns, [])
    assert.equal(navigate(child, returned), true)
    assert.equal(child.isDestroyed(), true)
    assert.deepEqual(returns, [returned])
    assert.deepEqual(shown, [entry.window])
    assert.equal(navigate(child, returned), true)
    assert.equal(returns.length, 1)
})

test('changing the owner or closing checkout prevents a late return', () => {
    const { entry, payments, windows, returns, navigate } = fixture()
    payments.open(entry, checkout)
    entry.contents.mainFrame.url = origin + '/board?workspace=2'
    assert.equal(navigate(windows[0], origin + '/templates'), true)
    payments.close(entry)
    assert.equal(windows[0].isDestroyed(), true)
    payments.open(entry, connect)
    windows[1].destroy()
    assert.equal(navigate(windows[1], origin + '/templates'), true)
    assert.deepEqual(returns, [])
})
