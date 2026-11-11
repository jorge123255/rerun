import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { installMacApplicationMenu } from '../src/main/application-menu.mjs'

test('the Mac Settings item opens only the current desktop frame', () => {
    let menu
    const Menu = { buildFromTemplate: template => template, setApplicationMenu: value => { menu = value } }
    const calls = []
    const frame = {
        url: 'file:///startup.html',
        send: (...args) => calls.push(args),
    }
    const window = {
        isDestroyed: () => false,
        isMinimized: () => true,
        restore: () => calls.push('restore'),
        show: () => calls.push('show'),
        focus: () => calls.push('focus'),
        webContents: { mainFrame: frame },
    }
    let current = null
    const desktopUrl = 'http://127.0.0.1:12345/desktop'
    installMacApplicationMenu({
        Menu, appName: 'Rerun Desktop Preview', settingsWindow: () => current,
        isDesktopPage: url => url === desktopUrl,
    })

    assert.equal(menu[0].label, 'Rerun Desktop Preview')
    assert(menu[0].submenu.some(item => item.role === 'about'))
    assert(menu[0].submenu.some(item => item.role === 'quit'))
    assert(menu.some(item => item.role === 'editMenu'))
    const settings = menu[0].submenu.find(item => item.id === 'rerun-settings')
    assert.equal(settings.accelerator, 'Command+,')
    settings.click()
    current = window
    settings.click()
    frame.url = desktopUrl + '/foreign'
    settings.click()
    frame.url = desktopUrl
    current = { ...window, isDestroyed: () => true }
    settings.click()
    assert.deepEqual(calls, [])

    current = window
    settings.click()
    assert.deepEqual(calls, ['restore', 'show', 'focus', ['desktop:open-settings']])
})

test('the preload forwards the Settings signal without exposing its IPC event', async () => {
    const ipcRenderer = new EventEmitter()
    const source = await readFile(new URL('../src/main/preload.cjs', import.meta.url), 'utf8')
    let desktopApp
    const contextBridge = { exposeInMainWorld: (name, api) => {
        assert.equal(name, 'desktopApp')
        desktopApp = api
    } }
    runInNewContext(source, { require: () => ({ contextBridge, ipcRenderer }) })

    const calls = []
    const unsubscribe = desktopApp.onOpenSettings((...args) => calls.push(args))
    ipcRenderer.emit('desktop:open-settings', { sender: 'privileged' }, { ignored: true })
    unsubscribe()
    ipcRenderer.emit('desktop:open-settings')
    assert.deepEqual(calls, [[]])
})
