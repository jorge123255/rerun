import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { checkHub, hubPartition, HUB_API_VERSION, normalizeHubOrigin, sameHub } from './connected-hub-policy.mjs'
import { createHubAuth } from './connected-hub-auth.mjs'
import { createHubDownloads } from './connected-hub-downloads.mjs'
import { atomicPrivateJSON, readJSON } from './workspaces/paths.mjs'
import { desktopMicrophonePermissions } from './media-permissions.mjs'
import { createNativeNotifications, hubNotificationPayload } from './notifications.mjs'
import { externalDesktopLink } from './window-context-menu.mjs'

const pickerPage = new URL('./connected-hub.html', import.meta.url)
const preload = fileURLToPath(new URL('./connected-hub-preload.cjs', import.meta.url))
const capabilities = ['auth', 'window', 'find', 'links', 'server', 'downloads', 'notifications', 'badge']

export function createConnectedHubs({ app, BrowserWindow, Notification, ipcMain, session, shell, dialog, dataRoot, available, openFind, closeFind, setUnread }) {
    const file = resolve(dataRoot, 'connected-hub.json')
    const windows = new Map()
    const childWindows = new Map()
    const usedSessions = new Set()
    const version = app.getVersion()
    const notices = createNativeNotifications({ Notification })
    let picker = null, connecting = null

    function connected(window) {
        if (!window || window.isDestroyed()) return null
        const entry = windows.get(window.webContents)
        return entry && sameHub(entry.contents.mainFrame?.url, entry.origin) ? entry : null
    }
    const downloads = createHubDownloads({ app, shell,
        ownerOf: contents => {
            if (!available()) return null
            const child = childWindows.get(contents)
            if (child) {
                const url = contents.mainFrame?.url
                if (url && url !== 'about:blank' && !sameHub(url, child.entry.origin)) return null
                return connected(child.entry.window)
            }
            return connected(windows.get(contents)?.window)
        },
        closeEmptyWindow: contents => {
            const child = childWindows.get(contents)
            if (child && !child.window.isDestroyed() && !sameHub(contents.mainFrame?.url, child.entry.origin)) {
                child.window.destroy()
            }
        },
        notify: (entry, value) => {
            if (connected(entry.window) === entry) entry.contents.send('hub:download', value)
        },
    })
    const localSender = event => picker && !picker.isDestroyed() && event.sender === picker.webContents
        && event.senderFrame && event.senderFrame === picker.webContents.mainFrame && event.senderFrame.url === pickerPage.href
    function hubSender(event) {
        const entry = windows.get(event.sender)
        return connected(entry?.window) && event.senderFrame && event.senderFrame === entry.contents.mainFrame ? entry : null
    }
    function publishUnread() {
        let count = 0
        for (const { native } of windows.values()) count += native?.unread ?? 0
        setUnread(count)
    }
    function invalidateNative(entry) {
        const native = entry.native
        entry.native = null
        if (!native) return
        notices.discard(native)
        if (native.unread) publishUnread()
    }
    function currentNative(entry, native) {
        return available() && entry.native === native && connected(entry.window) === entry
            && entry.contents.mainFrame === native.frame
    }
    async function notify(entry, value, frame) {
        const payload = hubNotificationPayload(value)
        const native = entry.native
        if (!payload || native?.frame !== frame) return false
        const { id, ...options } = payload
        const result = await notices.notify(JSON.stringify([native.id, id]), options, () => {
            if (!currentNative(entry, native)) return
            show(entry.window)
            native.frame.send('hub:notification-click', id)
        }, native)
        return result.status === 'accepted' && currentNative(entry, native)
    }
    function show(window) {
        if (!window || window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
    }
    async function savedOrigin() {
        const value = await readJSON(file).catch(() => null)
        const origin = normalizeHubOrigin(value?.origin)
        return origin && origin === value.origin ? origin : null
    }
    function external(value) {
        const url = externalDesktopLink(value)
        if (!url) return false
        void shell.openExternal(url).catch(() => {})
        return true
    }
    const preferences = desktopSession => ({ preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, session: desktopSession })

    function openPicker() {
        if (!available()) return
        if (picker && !picker.isDestroyed()) { show(picker); return }
        const isolated = session.fromPartition('rerun-connected-hub-picker')
        isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false))
        isolated.setPermissionCheckHandler(() => false)
        const window = new BrowserWindow({ width: 530, height: 440, minWidth: 460, minHeight: 390, show: false,
            title: 'Connect to Rerun', backgroundColor: '#101214', webPreferences: preferences(isolated) })
        picker = window
        for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, request => request.preventDefault())
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.once('closed', () => {
            if (picker !== window) return
            picker = null
            connecting?.abort()
            connecting = null
        })
        window.once('ready-to-show', () => show(window))
        void window.loadFile(fileURLToPath(pickerPage)).catch(() => window.destroy())
    }

    const stateOf = window => ({ focused: window.isFocused(), visible: window.isVisible() && !window.isMinimized(),
        fullscreen: window.isFullScreen(), maximized: window.isMaximized() })

    async function openHub(origin, desktopSession, path, signal) {
        signal.throwIfAborted()
        const address = new URL(path, origin)
        if (!sameHub(address, origin)) return false
        const existing = [...windows.values()].find(entry => entry.origin === origin && connected(entry.window))
        if (existing) {
            if (path !== '/') await existing.window.loadURL(address.href)
            signal.throwIfAborted()
            show(existing.window)
            return true
        }
        const window = new BrowserWindow({ width: 1220, height: 820, minWidth: 720, minHeight: 520, show: false,
            title: 'Rerun', backgroundColor: '#101214', titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 8 },
            webPreferences: preferences(desktopSession) })
        const contents = window.webContents
        usedSessions.add(desktopSession)
        downloads.track(desktopSession)
        const userAgent = contents.getUserAgent().replace(/ Electron\/\S+/, '') + ` RerunDesktop/${version} (mac; dev)`
        contents.setUserAgent(userAgent)
        const auth = createHubAuth({ origin, openBrowser: url => shell.openExternal(url), fetcher: (url, init) =>
            desktopSession.fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': userAgent } }) })
        const entry = { origin, window, contents, auth, scope: randomUUID(), closeAttempt: null }
        windows.set(contents, entry)
        const microphone = desktopMicrophonePermissions({
            context: source => available() && source && connected(windows.get(source)?.window)?.origin === origin
                && windows.get(source).window.isVisible() ? windows.get(source).window : null,
            isDesktopPage: url => sameHub(url, origin),
        })
        desktopSession.setPermissionRequestHandler(microphone.request)
        desktopSession.setPermissionCheckHandler(microphone.check)
        const navigation = (event, target) => {
            const url = event.url ?? target
            if (sameHub(url, origin)) return
            event.preventDefault()
        }
        contents.on('will-navigate', (event, target) => {
            navigation(event, target)
            const url = event.url ?? target
            if (!sameHub(url, origin) && available() && connected(window) && window.isFocused()) external(url)
        })
        contents.on('will-redirect', navigation)
        contents.on('will-attach-webview', event => event.preventDefault())
        contents.setWindowOpenHandler(({ url }) => {
            if (!available() || connected(window) !== entry) return { action: 'deny' }
            if (sameHub(url, origin)) {
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: {
                        width: 520, height: 700, show: false, autoHideMenuBar: true, backgroundColor: '#101214',
                        webPreferences: { session: desktopSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
                    },
                }
            }
            if (window.isFocused()) external(url)
            return { action: 'deny' }
        })
        contents.on('did-create-window', (child, { url }) => {
            if (!available() || connected(window) !== entry || !sameHub(url, origin)) { child.destroy(); return }
            const source = child.webContents
            childWindows.set(source, { window: child, entry })
            child.once('closed', () => childWindows.delete(source))
            source.setWindowOpenHandler(() => ({ action: 'deny' }))
            source.on('will-navigate', navigation)
            source.on('will-redirect', navigation)
            source.on('will-attach-webview', event => event.preventDefault())
            source.on('did-finish-load', () => { if (sameHub(source.mainFrame?.url, origin)) show(child) })
        })
        for (const event of ['focus', 'blur', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'show', 'hide', 'minimize', 'restore']) {
            window.on(event, () => { if (connected(window)) contents.send('hub:window-state', stateOf(window)) })
        }
        contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
            if (!mainFrame || inPlace) return
            entry.scope = randomUUID()
            closeFind(window)
        })
        contents.on('render-process-gone', () => invalidateNative(entry))
        contents.on('will-prevent-unload', event => {
            const result = dialog.showMessageBoxSync(window, { type: 'warning', title: 'Leave this Rerun page?',
                message: 'Some changes might not have been saved.', buttons: ['Stay', 'Leave'], defaultId: 0, cancelId: 0 })
            if (result === 1) event.preventDefault()
            else entry.closeAttempt?.(false)
        })
        window.once('closed', () => {
            closeFind(window)
            invalidateNative(entry)
            windows.delete(contents)
            for (const child of childWindows.values()) {
                if (child.entry === entry && !child.window.isDestroyed()) child.window.destroy()
            }
            auth.cancel()
            entry.closeAttempt?.(true)
        })
        const abort = () => { if (!window.isDestroyed()) window.destroy() }
        signal.addEventListener('abort', abort, { once: true })
        try {
            await window.loadURL(address.href)
            signal.throwIfAborted()
            if (!connected(window)) throw new Error('Server left its origin')
            show(window)
            return true
        } catch { abort(); return false }
        finally { signal.removeEventListener('abort', abort) }
    }

    async function connect(address, path = '/', parent) {
        if (!available() || connecting) return { ok: false, reason: 'busy' }
        const origin = normalizeHubOrigin(address)
        if (!origin) return { ok: false, reason: 'invalid' }
        const controller = new AbortController()
        connecting = controller
        try {
            const desktopSession = session.fromPartition(hubPartition(origin))
            const result = await checkHub(origin, version, desktopSession.fetch.bind(desktopSession),
                AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
            if (!result.ok) return result
            if (!available() || (parent && picker !== parent)) return { ok: false, reason: 'busy' }
            const opening = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)])
            if (!await openHub(origin, desktopSession, path, opening)) return { ok: false, reason: 'unreachable' }
            // The connection is usable even if the convenience of remembering its address fails.
            await atomicPrivateJSON(file, { origin }).catch(() => {})
            if (parent && !parent.isDestroyed()) setTimeout(() => { if (!parent.isDestroyed()) parent.close() }, 0)
            return { ok: true }
        } catch { return { ok: false, reason: 'unreachable' } }
        finally { if (connecting === controller) connecting = null }
    }

    async function redeem(entry, code, state) {
        const result = await entry.auth.redeem(code, state)
        if (connected(entry.window) !== entry || !available()) return { status: 'error', reason: 'expired' }
        if (result.status === 'signed-in') {
            show(entry.window)
            void entry.window.loadURL(entry.origin + '/').catch(() => {})
        }
        entry.contents.send('hub:auth-result', result)
        return result
    }

    ipcMain.on('hub:bootstrap', event => {
        if (localSender(event)) { event.returnValue = { audience: 'picker' }; return }
        const entry = hubSender(event)
        if (!entry || !available()) { event.returnValue = null; return }
        invalidateNative(entry)
        entry.native = { frame: event.senderFrame, id: randomUUID(), unread: 0 }
        event.returnValue = { audience: 'hub', apiVersion: HUB_API_VERSION, version, platform: 'mac', channel: 'dev', capabilities }
    })
    ipcMain.handle('hub:saved-origin', event => localSender(event) ? savedOrigin() : null)
    ipcMain.handle('hub:connect', (event, address) => localSender(event) ? connect(address, '/', picker) : { ok: false, reason: 'invalid' })
    for (const [channel, action] of [
        ['hub:window-state', entry => stateOf(entry.window)],
        ['hub:window-chrome', (entry, colors) => {
            if (typeof colors?.frameColor === 'string' && /^#[0-9a-f]{6}$/i.test(colors.frameColor)) entry.window.setBackgroundColor(colors.frameColor)
        }],
        ['hub:find', entry => openFind(entry.window)],
        ['hub:open-link', (_entry, url) => external(url)],
        ['hub:show-download', (entry, id) => downloads.show(entry, id)],
        ['hub:notify', (entry, value, frame) => notify(entry, value, frame)],
        ['hub:badge', (entry, count, frame) => {
            if (entry.native?.frame !== frame || !Number.isSafeInteger(count) || count < 0) return
            const unread = Math.min(count, 9999)
            if (entry.native.unread === unread) return
            entry.native.unread = unread
            publishUnread()
        }],
        ['hub:open-picker', () => openPicker()],
        ['hub:auth-start', (entry, options) => entry.auth.start(options?.provider)],
        ['hub:auth-code', (entry, code) => redeem(entry, code)],
    ]) ipcMain.handle(channel, (event, value) => {
        const entry = hubSender(event)
        if (!entry || !available()) throw new Error('Untrusted Rerun hub request')
        return action(entry, value, event.senderFrame)
    })

    return {
        openPicker,
        scopeOf: window => available() ? connected(window)?.scope : null,
        async openLink(link) {
            if (!available()) return
            if (link.kind === 'auth') {
                const entry = [...windows.values()].find(value => connected(value.window) && value.auth.matches(link.state))
                if (entry) await redeem(entry, link.code, link.state)
                return
            }
            const origin = await savedOrigin()
            if (origin) await connect(origin, link.path)
            else openPicker()
        },
        async closeAll() {
            connecting?.abort()
            for (const entry of [...windows.values()]) {
                if (entry.window.isDestroyed()) continue
                const closed = await new Promise(done => {
                    const timer = setTimeout(() => finish(false), 5000)
                    function finish(result) { clearTimeout(timer); entry.closeAttempt = null; done(result) }
                    entry.closeAttempt = finish
                    entry.window.close()
                })
                if (!closed) throw new Error('A connected Rerun window is still open')
            }
            if (picker && !picker.isDestroyed()) picker.destroy()
            downloads.cancelAll()
            // Chromium batches writes. Persist session cookies even if the last hub
            // was closed just before quitting the local app.
            await Promise.all([...usedSessions].map(value => value.cookies.flushStore()))
        },
    }
}
