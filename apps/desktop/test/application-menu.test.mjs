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
        openDocumentation: () => calls.push('documentation'),
        openFind: () => calls.push('find'),
        openNewWindow: () => calls.push('new-window'),
        openLocalWorkspace: () => calls.push('open-local'),
        openHubPicker: () => calls.push('connect-hub'),
        reloadWindow: (_item, target) => calls.push(['reload', target]),
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
    const help = menu.find(item => item.role === 'help')
    help.submenu.find(item => item.id === 'rerun-documentation').click()
    assert.equal(calls.at(-1), 'documentation')
    const edit = menu.find(item => item.role === 'editMenu')
    assert(edit.submenu.some(item => item.role === 'paste'))
    edit.submenu.find(item => item.id === 'rerun-find').click()
    assert.equal(calls.at(-1), 'find')
    const newWindow = menu.find(item => item.role === 'fileMenu').submenu.find(item => item.id === 'rerun-new-window')
    assert.equal(newWindow.accelerator, 'CmdOrCtrl+Shift+N')
    newWindow.click()
    assert.equal(calls.at(-1), 'new-window')
    const local = menu.find(item => item.role === 'fileMenu').submenu.find(item => item.id === 'rerun-open-local')
    assert.equal(local.label, 'Open Local Workspace')
    local.click()
    assert.equal(calls.at(-1), 'open-local')
    menu.find(item => item.role === 'fileMenu').submenu.find(item => item.id === 'rerun-connect-hub').click()
    assert.equal(calls.at(-1), 'connect-hub')
    const view = menu.find(item => item.label === 'View')
    assert(!view.role)
    assert(!view.submenu.some(item => ['reload', 'forceReload', 'toggleDevTools'].includes(item.role)))
    const reload = view.submenu.find(item => item.id === 'rerun-reload')
    assert.equal(reload.accelerator, 'CmdOrCtrl+R')
    reload.click(reload, window)
    assert.deepEqual(calls.at(-1), ['reload', window])
})

test('the preload forwards the Settings signal without exposing its IPC event', async () => {
    const ipcRenderer = new EventEmitter()
    const source = await readFile(new URL('../src/main/preload.cjs', import.meta.url), 'utf8')
    let desktopApp
    const contextBridge = { exposeInMainWorld: (name, api) => {
        assert.equal(name, 'desktopApp')
        desktopApp = api
    } }
    runInNewContext(source, { process: { platform: 'darwin' }, require: () => ({ contextBridge, ipcRenderer }) })

    const calls = []
    const unsubscribe = desktopApp.onOpenSettings((...args) => calls.push(args))
    ipcRenderer.emit('desktop:open-settings', { sender: 'privileged' }, { ignored: true })
    unsubscribe()
    ipcRenderer.emit('desktop:open-settings')
    assert.deepEqual(calls, [[]])
})

test('the Mac full-screen subscription reports booleans and never overwrites a newer event', async () => {
    const ipcRenderer = new EventEmitter()
    const source = await readFile(new URL('../src/main/preload.cjs', import.meta.url), 'utf8')
    let desktopApp, resolveInitial
    ipcRenderer.invoke = channel => {
        assert.equal(channel, 'desktop:mac-fullscreen')
        return new Promise(resolve => { resolveInitial = resolve })
    }
    const contextBridge = { exposeInMainWorld: (_name, api) => { desktopApp = api } }
    runInNewContext(source, { process: { platform: 'darwin' }, require: () => ({ contextBridge, ipcRenderer }) })
    const channel = 'desktop:mac-fullscreen-changed'
    const calls = []
    const subscribe = () => desktopApp.onMacFullscreen((...args) => calls.push(args))
    const unsubscribe = subscribe()
    ipcRenderer.emit(channel, { sender: 'privileged' }, true)
    ipcRenderer.emit(channel, {}, 'not a boolean')
    resolveInitial(false)
    await Promise.resolve()
    assert.deepEqual(calls, [[true]])
    unsubscribe()
    ipcRenderer.emit(channel, {}, false)
    assert.deepEqual(calls, [[true]])
    const stop = subscribe()
    resolveInitial(false)
    await Promise.resolve()
    assert.deepEqual(calls, [[true], [false]])
    stop()
    assert.equal(ipcRenderer.listenerCount(channel), 0)
})
