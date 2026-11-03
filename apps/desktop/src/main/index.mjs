import { app, BrowserWindow, ipcMain, safeStorage, shell, session } from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { loadBundle, loadIdentity } from './runtime.mjs'
import { RuntimeSupervisor } from './supervisor.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const startup = resolve(directory, 'startup.html')
let window
let supervisor
let runtime
let quitting = false
let quittingNow = false
let bootStatus = { state: 'starting', message: 'Preparing local runtime…' }
const profile = 'persist:rerun-desktop-local'

if (!app.requestSingleInstanceLock()) app.quit()
else {
    app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() })
    app.on('activate', () => { window?.show(); window?.focus() })
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
    app.on('before-quit', event => {
        if (quittingNow) return
        event.preventDefault()
        if (quitting) return
        quitting = true
        void (async () => {
            try { await supervisor?.stop() } finally { quittingNow = true; app.quit() }
        })()
    })
    app.whenReady().then(launch).catch(() => {
        bootStatus = { state: 'error', message: 'Desktop setup failed. Check that this app has a complete bundled runtime and access to Mac secure storage.' }
        window?.webContents.send('desktop:status', bootStatus)
    })
}

function trusted(event) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted desktop request')
    const url = new URL(event.senderFrame.url)
    if (url.href !== pathToFileURL(startup).href && (!runtime || url.origin !== runtime.app.origin || url.pathname !== '/desktop')) throw new Error('Untrusted desktop page')
}

async function launch() {
    const dataRoot = resolve(app.getPath('appData'), 'Rerun Desktop Preview')
    await mkdir(dataRoot, { recursive: true, mode: 0o700 })
    app.setPath('userData', dataRoot)
    const desktopSession = session.fromPartition(profile)
    desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    desktopSession.setPermissionCheckHandler(() => false)
    window = new BrowserWindow({
        width: 1220, height: 820, minWidth: 720, minHeight: 520, show: false,
        title: 'Rerun Desktop Preview', backgroundColor: '#101214',
        webPreferences: { preload: resolve(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: profile },
    })
    window.once('ready-to-show', () => window.show())
    window.on('close', event => { if (!quitting && process.platform === 'darwin') { event.preventDefault(); window.hide() } })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-navigate', (event, target) => {
        let url
        try { url = new URL(target) } catch { event.preventDefault(); return }
        if (!runtime || url.origin !== runtime.app.origin || url.pathname !== '/desktop') event.preventDefault()
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url)
            if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) void shell.openExternal(parsed.href)
        } catch {}
        return { action: 'deny' }
    })
    ipcMain.handle('desktop:status', event => { trusted(event); return supervisor?.status ?? bootStatus })
    ipcMain.handle('desktop:retry', async event => {
        trusted(event)
        if (!supervisor) { app.relaunch(); app.quit(); return true }
        if (['starting', 'stopping'].includes(supervisor.status.state)) return false
        runtime = null
        await window.loadFile(startup)
        await supervisor.stop()
        await startWorkspace(desktopSession)
        return true
    })
    ipcMain.handle('desktop:quit', event => { trusted(event); app.quit() })
    await window.loadFile(startup)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Mac secure storage is unavailable')
    const identity = await loadIdentity(dataRoot, { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) })
    const resources = app.isPackaged ? process.resourcesPath : resolve(directory, '../../resources')
    const bundle = await loadBundle(resources)
    supervisor = new RuntimeSupervisor({ bundle, root: dataRoot, identity })
    supervisor.on('status', status => {
        if (!window?.isDestroyed()) window.webContents.send('desktop:status', status)
        if (status.state === 'error') { runtime = null; void window.loadFile(startup) }
    })
    await startWorkspace(desktopSession)
}

async function startWorkspace(desktopSession) {
    try {
        runtime = await supervisor.start()
        await desktopSession.cookies.set({ url: runtime.app.origin, name: 'rerun-desktop-session', value: runtime.app.sessionToken, httpOnly: true, sameSite: 'strict', path: '/' })
        await window.loadURL(`${runtime.app.origin}/desktop`)
    } catch {
        window.webContents.send('desktop:status', supervisor.status)
    }
}
