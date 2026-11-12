import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createWindowFind } from '../src/main/window-find.mjs'

test('page Find accepts only its sandboxed frame and discards stale requests and scopes', async () => {
    let scope = 'workspace-renderer', lastRequest = 0, currentView
    const calls = []
    const contents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        findInPage: (text, options) => { calls.push({ text, options }); return ++lastRequest },
        stopFindInPage: action => calls.push(action),
        focus: () => calls.push('focus-board'),
    })
    const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        focus: () => calls.push('focus-window'),
        webContents: contents,
        getContentSize: () => [900, 600],
        contentView: { addChildView: view => assert.equal(view, currentView), removeChildView: view => assert.equal(view, currentView) },
    })
    class View {
        constructor({ webPreferences }) {
            assert.equal(webPreferences.sandbox, true)
            assert.equal(webPreferences.contextIsolation, true)
            assert.equal(webPreferences.nodeIntegration, false)
            assert.equal(webPreferences.partition, 'rerun-desktop-find')
            currentView = this
            this.webContents = Object.assign(new EventEmitter(), {
                mainFrame: { url: '' }, isDestroyed: () => false,
                loadFile: async path => { this.webContents.mainFrame.url = pathToFileURL(path).href },
                setWindowOpenHandler: () => {}, focus: () => {}, send: (...args) => calls.push(args),
                close: () => calls.push('close-bar'),
            })
        }
        setBackgroundColor() {}
        setBounds(bounds) { assert.deepEqual(bounds, { x: 508, y: 12, width: 380, height: 52 }) }
    }
    const find = createWindowFind({ WebContentsView: View, scopeOf: owner => owner === window ? scope : null })
    find.open(window)
    await Promise.resolve()
    const sender = currentView.webContents
    const event = { sender, senderFrame: sender.mainFrame }
    assert.deepEqual(calls.splice(0), [['desktop:find-focus']])
    find.search({ sender, senderFrame: {} }, { text: 'foreign' })
    find.search(event, { text: 'x'.repeat(501) })
    assert.deepEqual(calls, [])
    find.search(event, { text: 'alpha' })
    find.search(event, { text: 'alpha', step: true, forward: false })
    assert.deepEqual(calls, [
        { text: 'alpha', options: { forward: true, findNext: true } },
        { text: 'alpha', options: { forward: false, findNext: false } },
    ])
    contents.emit('found-in-page', {}, { requestId: 1, finalUpdate: true, matches: 4 })
    contents.emit('found-in-page', {}, { requestId: 2, finalUpdate: false, matches: 1 })
    assert.equal(calls.length, 2)
    contents.emit('found-in-page', {}, { requestId: 2, finalUpdate: true, matches: 4, activeMatchOrdinal: 3 })
    assert.deepEqual(calls.at(-1), ['desktop:find-result', { total: 4, active: 3 }])
    find.search(event, { text: '' })
    assert.deepEqual(calls.slice(-2), ['clearSelection', ['desktop:find-result', { total: 0, active: 0 }]])
    scope = 'another-renderer'
    find.search(event, { text: 'stale' })
    assert.equal(lastRequest, 2)
    window.emit('hide')
    assert.equal(contents.listenerCount('found-in-page'), 0)
    assert.deepEqual(calls.slice(-2), ['clearSelection', 'close-bar'])
    find.open(window)
    await Promise.resolve()
    const newSender = currentView.webContents
    find.dismiss({ sender: newSender, senderFrame: newSender.mainFrame })
    assert.deepEqual(calls.slice(-4), ['keepSelection', 'close-bar', 'focus-window', 'focus-board'])
})

test('the Find field handles Return and Shift-Return directly after focusing', async () => {
    const calls = [], listeners = new Map()
    const query = { value: 'alpha', addEventListener: () => {}, focus: () => calls.push('focus'), select: () => calls.push('select') }
    const elements = { query, count: {}, previous: { addEventListener: () => {} }, next: {}, close: { addEventListener: () => {} } }
    const document = {
        getElementById: id => elements[id],
        querySelector: () => ({ addEventListener: () => {} }),
        addEventListener: (event, handler) => listeners.set(event, handler),
    }
    const desktopFind = {
        onResult: handler => handler({ active: 1, total: 2 }),
        onFocus: handler => handler(),
        search: (...args) => calls.push(args),
    }
    runInNewContext(await readFile(new URL('../src/main/find.js', import.meta.url), 'utf8'), { window: { desktopFind }, document })
    const preventDefault = () => calls.push('prevent-default')
    for (const shiftKey of [false, true]) listeners.get('keydown')({ key: 'Enter', shiftKey, target: query, preventDefault })
    assert.deepEqual(calls, ['focus', 'select', 'prevent-default', ['alpha', true, true], 'prevent-default', ['alpha', false, true]])
})
