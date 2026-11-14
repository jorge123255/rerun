import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createMacMenuBar } from '../src/main/mac-menu-bar.mjs'

function fixture({ packaged = false, locale = 'en-US', openedAtLogin = false, quickAsk } = {}) {
    const app = new EventEmitter()
    const calls = []
    let settings = { openAtLogin: false, wasOpenedAtLogin: openedAtLogin }
    Object.assign(app, {
        name: 'Rerun Preview', isPackaged: packaged,
        getLocale: () => locale,
        getLoginItemSettings: () => { assert(packaged); return settings },
        setLoginItemSettings: value => { calls.push(value); settings = { ...settings, ...value } },
        quit: () => calls.push('quit'),
    })
    const image = {
        addRepresentation: ({ scaleFactor, buffer }) => {
            assert.equal(buffer.subarray(1, 4).toString(), 'PNG')
            calls.push(scaleFactor)
        },
        setTemplateImage: value => assert.equal(value, true),
    }
    let tray
    class Tray {
        constructor(value) { assert.equal(value, image); tray = this }
        setContextMenu(menu) { this.menu = menu }
        setToolTip(tooltip) { this.tooltip = tooltip }
        setTitle(title) { this.title = title }
        destroy() { calls.push('destroy') }
    }
    const Menu = {
        buildFromTemplate(items) {
            return Object.assign(new EventEmitter(), { getMenuItemById: id => items.find(item => item.id === id) })
        },
    }
    const bar = createMacMenuBar({
        app, Menu, Tray, openWindow: () => calls.push('open'), quickAsk,
        nativeImage: { createEmpty: () => image, createFromPath: path => ({ isEmpty: () => false, toPNG: () => readFileSync(path) }) },
    })
    return { app, bar, calls, tray, item: id => tray.menu.getMenuItemById('rerun-tray-' + id) }
}

test('the menu-bar icon shows the unread total, opens the board and quits through the app', () => {
    const { app, bar, calls, item, tray } = fixture({ locale: 'fr-CA' })
    assert.deepEqual(calls, [1, 2])
    assert.equal(item('open').label, 'Ouvrir Rerun Preview')
    assert.equal(tray.title, '')
    assert.equal(item('unread'), undefined)
    bar.setUnread(101)
    assert.equal(tray.title, '99+')
    assert.equal(item('unread').label, '101 en attente de vous')
    assert.equal(item('unread').enabled, false)
    assert.equal(tray.tooltip, 'Rerun Preview · 101 en attente de vous')
    bar.setUnread(0)
    assert.equal(item('unread'), undefined)
    assert.equal(tray.title, '')
    assert.equal(tray.tooltip, 'Rerun Preview')
    item('open').click()
    item('quit').click()
    app.emit('will-quit')
    assert.deepEqual(calls, [1, 2, 'open', 'quit', 'destroy'])
})

test('the menu-bar Quick Ask entry tracks the saved shortcut preference', () => {
    let enabled = true, opened = 0
    const { item, tray } = fixture({ quickAsk: { enabled: () => enabled, open: () => { opened++ } } })
    assert.equal(item('quick-ask').enabled, true)
    assert.equal(item('quick-ask').registerAccelerator, false)
    item('quick-ask').click()
    enabled = false
    tray.menu.emit('menu-will-show')
    assert.equal(item('quick-ask').enabled, false)
    item('quick-ask').click()
    assert.equal(opened, 1)
})

test('Open at Login is an explicit packaged action and reads back the OS setting', () => {
    const dev = fixture()
    assert.equal(dev.bar.startedAtLogin, false)
    assert.equal(dev.item('login').enabled, false)
    dev.item('login').click({ checked: true })
    assert.deepEqual(dev.calls, [1, 2])

    const packaged = fixture({ packaged: true, openedAtLogin: true })
    assert.equal(packaged.bar.startedAtLogin, true)
    assert.equal(packaged.item('login').enabled, true)
    assert.equal(packaged.item('login').checked, false)
    assert.deepEqual(packaged.calls, [1, 2])
    packaged.item('login').click({ checked: true })
    assert.deepEqual(packaged.calls, [1, 2, { openAtLogin: true }])
    assert.equal(packaged.item('login').checked, true)

    packaged.app.setLoginItemSettings = () => { throw new Error('System refused change') }
    packaged.item('login').click({ checked: false })
    assert.equal(packaged.item('login').checked, true)
    packaged.app.getLoginItemSettings = () => ({ openAtLogin: false })
    packaged.tray.menu.emit('menu-will-show')
    assert.equal(packaged.item('login').checked, false)
})
