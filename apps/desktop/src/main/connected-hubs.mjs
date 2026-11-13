import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { checkHub, hubPartition, hubWindowAddress, HUB_API_VERSION, isPublishedPageHandoff, normalizeHubOrigin, parseHubWorkspaceId, RERUN_CLOUD_ORIGIN, sameHub } from './connected-hub-policy.mjs'
import { cascadeWindowBounds } from './board-windows.mjs'
import { hubConnectionError, hubOfflineCopy, hubPickerCopy, hubRecoveryView } from './connected-hub-messages.mjs'
import { shellText } from './shell-language.mjs'
import { restoreWindowZoom } from './window-placement.mjs'
import { hideWorkspaceWindow, revealWorkspaceWindow as show } from './window-visibility.mjs'
import { createHubAuth } from './connected-hub-auth.mjs'
import { createHubDownloads, isHubDownload } from './connected-hub-downloads.mjs'
import { createConnectedHubQuickAsk } from './connected-hub-quick-ask.mjs'
import { createHubRecovery } from './connected-hub-recovery.mjs'
import { createHubPaymentWindows } from './connected-hub-payment.mjs'
import { createHubServiceSignIn } from './connected-hub-service-sign-in.mjs'
import { atomicPrivateJSON, readJSON } from './workspaces/paths.mjs'
import { desktopMicrophonePermissions } from './media-permissions.mjs'
import { createNativeNotifications, hubNotificationPayload } from './notifications.mjs'
import { QUICK_ASK_SHORTCUT } from './quick-ask-window.mjs'
import { attachDesktopContextMenu, externalDesktopLink } from './window-context-menu.mjs'

const pickerPage = new URL('./connected-hub.html', import.meta.url)
const offlinePage = new URL('./connected-hub-offline.html', import.meta.url)
const downloadPage = 'https://rerun.build/download'
const preload = fileURLToPath(new URL('./connected-hub-preload.cjs', import.meta.url))
const capabilities = ['auth', 'window', 'find', 'links', 'server', 'downloads', 'notifications', 'badge', 'settings', 'oauth', 'locale']
const appearanceOf = value => value === 'light' || value === 'dark' ? value : null
const backgroundFor = appearance => appearance === 'light' ? '#fafafa' : '#101214'
const opaqueColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

export function createConnectedHubs({ app, BrowserWindow, Menu, clipboard, Notification, ipcMain, session, shell, dialog, screen, dataRoot, windowPlacements,
    updates, canRestartForUpdate, available, openFind, closeFind, setUnread, desktopSettings, changeDesktopSettings, setLanguage, language, onConnect,
    systemAppearance }) {
    const file = resolve(dataRoot, 'connected-hub.json')
    const windows = new Map()
    const childWindows = new Map()
    const usedSessions = new Set()
    const version = app.getVersion()
    const shellIdentity = { apiVersion: HUB_API_VERSION, version, platform: 'mac', channel: 'dev' }
    const notices = createNativeNotifications({ Notification })
    const quickAsk = createConnectedHubQuickAsk({ app, BrowserWindow, screen, preload,
        current: entry => available() && connected(entry.window) === entry && singleQuickAskReceiver(entry),
        showOwner: entry => show(entry.window),
        onUnavailable: entry => { void dialog.showMessageBox(entry.window, { type: 'warning', title: 'Quick Ask',
            message: 'Quick Ask could not open on this Rerun server.', buttons: ['OK'] }).catch(() => {}) },
    })
    let picker = null, pickerLocale = null, acceptedPicker = null, connecting = null
    let pendingOpen = null, openingLink = false
    let appearanceWrites = Promise.resolve()
    const appearancePath = origin => resolve(dataRoot, `hub-appearance-${createHash('sha256').update(origin).digest('hex')}.json`)

    function entryFor(window) {
        if (!window || window.isDestroyed()) return null
        return windows.get(window.webContents) ?? null
    }
    function connected(window) {
        const entry = entryFor(window)
        return entry && !entry.recovery?.state() && sameHub(entry.contents.mainFrame?.url, entry.origin) ? entry : null
    }
    const payments = createHubPaymentWindows({ BrowserWindow, show, enabled: !process.mas,
        isCurrent: entry => available() && connected(entry.window) === entry })
    function singleQuickAskReceiver(entry) {
        // The upstream web composer writes one origin-wide key; its receiver
        // must be unique because workspace choice belongs to each tab.
        return ![...windows.values()].some(other => other !== entry && other.origin === entry.origin && !other.window.isDestroyed())
            && ![...childWindows.values()].some(child => child.entry.origin === entry.origin
                && !child.window.isDestroyed() && sameHub(child.window.webContents.mainFrame?.url, entry.origin))
    }
    function resetHubQuickAsk(origin) {
        for (const entry of windows.values()) if (entry.origin === origin) quickAsk.reset(entry)
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
    const serviceSignIn = createHubServiceSignIn({ channel: 'dev', openBrowser: url => shell.openExternal(url) })
    const localSender = event => picker && !picker.isDestroyed() && event.sender === picker.webContents
        && event.senderFrame && event.senderFrame === picker.webContents.mainFrame && event.senderFrame.url === pickerPage.href
    function offlineSender(event) {
        const entry = windows.get(event.sender)
        return available() && event.senderFrame && entry?.recovery.onOfflinePage() && event.senderFrame === entry.contents.mainFrame ? entry : null
    }
    function incompatibleSender(event) {
        const entry = offlineSender(event)
        return entry?.recovery.state()?.reason === 'too-old' ? entry : null
    }
    function hubSender(event) {
        const entry = windows.get(event.sender)
        return connected(entry?.window) && event.senderFrame && event.senderFrame === entry.contents.mainFrame ? entry : null
    }
    function publishUnread() {
        const byOrigin = new Map()
        for (const { origin, native } of windows.values()) {
            if (!native?.unread) continue
            if (!byOrigin.has(origin)) byOrigin.set(origin, new Map())
            const counts = byOrigin.get(origin)
            counts.set(native.workspaceId, Math.max(counts.get(native.workspaceId) ?? 0, native.unread))
        }
        let count = 0
        for (const counts of byOrigin.values()) {
            const unscoped = counts.get(null) ?? 0
            counts.delete(null)
            count += Math.max(unscoped, [...counts.values()].reduce((sum, value) => sum + value, 0))
        }
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
    function updateState(state) {
        // The connected server needs the display state, never native diagnostics or feed details.
        return state.status === 'error' ? { status: 'error', message: 'The update check failed.' } : state
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
    async function savedOrigin() {
        const value = await readJSON(file).catch(() => null)
        const origin = normalizeHubOrigin(value?.origin)
        return origin && origin === value.origin ? origin : null
    }
    async function openPendingLink() {
        if (!available() || openingLink || connecting || picker || !pendingOpen) return
        openingLink = true
        const request = pendingOpen
        try {
            const origin = await savedOrigin()
            if (!available() || picker || connecting || pendingOpen !== request) return
            if (!origin) { openPicker(); return }
            pendingOpen = null
            const result = await connect(origin, { path: request.path, remember: false })
            if (!result.ok && available()) {
                pendingOpen ??= request
                openPicker()
            }
        } finally {
            openingLink = false
            if (pendingOpen && pendingOpen !== request) void openPendingLink()
        }
    }
    function external(value) {
        const url = externalDesktopLink(value)
        if (!url) return false
        void shell.openExternal(url).catch(() => {})
        return true
    }
    const preferences = desktopSession => ({ preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        spellcheck: true, session: desktopSession })

    function openPicker() {
        if (!available()) return
        if (picker && !picker.isDestroyed()) { show(picker); return }
        pickerLocale = language()
        const isolated = session.fromPartition('rerun-connected-hub-picker')
        isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false))
        isolated.setPermissionCheckHandler(() => false)
        const window = new BrowserWindow({ width: 530, height: 440, minWidth: 460, minHeight: 390, show: false,
            title: hubPickerCopy(pickerLocale).title, backgroundColor: '#101214', webPreferences: preferences(isolated) })
        picker = window
        for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, request => request.preventDefault())
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.once('closed', () => {
            if (picker !== window) return
            picker = null
            pickerLocale = null
            if (acceptedPicker === window) {
                acceptedPicker = null
                void openPendingLink()
                return
            }
            pendingOpen = null
            connecting?.abort()
            connecting = null
        })
        window.once('ready-to-show', () => show(window))
        void window.loadFile(fileURLToPath(pickerPage)).catch(() => window.destroy())
    }

    const stateOf = window => ({ focused: window.isFocused(), visible: window.isVisible() && !window.isMinimized(),
        fullscreen: window.isFullScreen(), maximized: window.isMaximized() })

    async function openHub(origin, desktopSession, path, signal, issue, bounds, reveal = () => true) {
        signal.throwIfAborted()
        const address = new URL(path ?? '/', origin)
        if (!sameHub(address, origin)) return false
        const placement = bounds ? null : await windowPlacements.restore(origin)
        signal.throwIfAborted()
        const existing = !bounds && [...windows.values()].find(entry => entry.origin === origin && !entry.window.isDestroyed())
        if (existing) {
            const target = path === null ? existing.recovery.target() : address.href
            if (issue) {
                if (!await existing.recovery.showOffline(target, issue.reason, issue.minimum)) return false
            } else if (path !== null || existing.recovery.state()) {
                if (!await existing.recovery.navigate(target)) return false
            }
            signal.throwIfAborted()
            if (reveal()) show(existing.window)
            return true
        }
        const primary = !bounds
        await appearanceWrites
        const savedAppearance = await readJSON(appearancePath(origin)).catch(() => null)
        signal.throwIfAborted()
        const appearance = savedAppearance?.version === 1 ? appearanceOf(savedAppearance.appearance) : null
        const window = new BrowserWindow({ ...(placement?.bounds ?? bounds), minWidth: 720, minHeight: 520, show: false,
            title: 'Rerun', backgroundColor: backgroundFor(appearance ?? systemAppearance()),
            titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 8 },
            // Keep the connected board's activity and unread updates running while it is hidden.
            webPreferences: { ...preferences(desktopSession), backgroundThrottling: !primary } })
        const contents = window.webContents
        usedSessions.add(desktopSession)
        downloads.track(desktopSession)
        const userAgent = contents.getUserAgent().replace(/ Electron\/\S+/, '') + ` RerunDesktop/${version} (mac; dev)`
        contents.setUserAgent(userAgent)
        const auth = createHubAuth({ origin, openBrowser: url => shell.openExternal(url), fetcher: (url, init) =>
            desktopSession.fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': userAgent } }) })
        const entry = { origin, window, contents, auth, primary, appearance, scope: randomUUID(), closeAttempt: null }
        entry.recovery = createHubRecovery({ window, origin, offlinePage, available,
            check: signal => checkHub(origin, version, desktopSession.fetch.bind(desktopSession),
                AbortSignal.any([signal, AbortSignal.timeout(5000)])),
            invalidate: () => {
                window.setBackgroundColor(backgroundFor(entry.appearance ?? systemAppearance()))
                payments.close(entry)
                entry.scope = randomUUID()
                auth.cancel()
                quickAsk.reset(entry)
                closeFind(window)
                invalidateNative(entry)
            },
        })
        windows.set(contents, entry)
        attachDesktopContextMenu({
            window, Menu, clipboard, openExternal: external, locale: () => language(origin),
            currentScope: () => available() && connected(window) === entry ? entry.scope : null,
            canSaveImage: (_page, source) => isHubDownload([source], origin),
            saveImage: (_page, source) => contents.downloadURL(source),
        })
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
        const openPayment = (event, url) => (!event.initiator || event.initiator === contents.mainFrame) && payments.open(entry, url)
        contents.on('will-navigate', (event, target) => {
            navigation(event, target)
            const url = event.url ?? target
            if (!sameHub(url, origin) && available() && connected(window) && window.isFocused()
                && !openPayment(event, url)) external(url)
        })
        contents.on('will-redirect', (event, target) => {
            navigation(event, target)
            const url = event.url ?? target
            if (event.isMainFrame && !sameHub(url, origin)) openPayment(event, url)
        })
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
            const ownerScope = entry.scope
            const ownerFrame = contents.mainFrame
            let initialNavigation = true
            childWindows.set(source, { window: child, entry })
            child.once('closed', () => childWindows.delete(source))
            source.setWindowOpenHandler(() => ({ action: 'deny' }))
            source.on('will-navigate', navigation)
            source.on('will-redirect', (event, target) => {
                navigation(event, target)
                const address = event.url ?? target
                if (!event.isMainFrame || !initialNavigation || !isPublishedPageHandoff(url, address, origin)
                    || !available() || connected(window) !== entry || !window.isVisible()
                    || entry.scope !== ownerScope || contents.mainFrame !== ownerFrame) return
                // The browser receives only the server-issued link. The hub
                // session stays in Electron and the transient window closes.
                initialNavigation = false
                child.destroy()
                external(address)
            })
            source.on('will-attach-webview', event => event.preventDefault())
            source.on('did-navigate', (_event, url) => {
                if (!sameHub(url, origin)) return
                initialNavigation = false
                resetHubQuickAsk(origin)
            })
            source.on('did-finish-load', () => { if (sameHub(source.mainFrame?.url, origin)) show(child) })
        })
        for (const event of ['focus', 'blur', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'show', 'hide', 'minimize', 'restore']) {
            window.on(event, () => { if (connected(window)) contents.send('hub:window-state', stateOf(window)) })
        }
        if (primary) window.on('close', event => {
            if (!available()) return
            event.preventDefault()
            payments.close(entry)
            quickAsk.reset(entry)
            closeFind(window)
            hideWorkspaceWindow(window)
        })
        contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
            if (!mainFrame || inPlace) return
            payments.close(entry)
            quickAsk.reset(entry)
            entry.scope = randomUUID()
            closeFind(window)
        })
        contents.on('did-navigate-in-page', (_event, _url, mainFrame) => { if (mainFrame) payments.close(entry) })
        contents.on('will-prevent-unload', event => {
            const t = shellText(language(entry.origin))
            const result = dialog.showMessageBoxSync(window, { type: 'warning', message: t('unload.message'),
                detail: t('unload.detail'), buttons: [t('unload.stay'), t('unload.leave')], defaultId: 0, cancelId: 0 })
            if (result === 1) event.preventDefault()
            else entry.closeAttempt?.(false)
        })
        window.once('closed', () => {
            payments.close(entry)
            closeFind(window)
            quickAsk.reset(entry)
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
            const opened = issue ? await entry.recovery.showOffline(address.href, issue.reason, issue.minimum) : await entry.recovery.navigate(address.href)
            signal.throwIfAborted()
            if (!opened) throw new Error('Server left its origin')
            if (placement) {
                restoreWindowZoom(window, placement.maximized)
                const capture = windowPlacements.track(origin, window)
                window.on('close', () => { capture(); void windowPlacements.flush() })
            }
            if (reveal()) show(window)
            return true
        } catch { abort(); return false }
        finally { signal.removeEventListener('abort', abort) }
    }

    async function duplicateHub(entry) {
        const scope = entry.scope
        const offline = entry.recovery.onOfflinePage()
        let address = entry.recovery.target()
        if (!offline) {
            if (connected(entry.window) !== entry) return
            const frame = entry.contents.mainFrame
            const page = frame.url
            const workspace = await frame.executeJavaScript('sessionStorage.getItem("rerun:tab-workspace")').catch(() => null)
            if (!available() || connected(entry.window) !== entry || entry.scope !== scope
                || entry.contents.mainFrame !== frame || frame.url !== page) return
            address = hubWindowAddress(page, entry.origin, workspace)
        }
        if (!address) return
        resetHubQuickAsk(entry.origin)
        await openHub(entry.origin, entry.contents.session, address, AbortSignal.timeout(25000), offline ? entry.recovery.state() : null,
            cascadeWindowBounds(entry.window, screen))
    }

    async function connect(address, { path = null, parent, remember = true, signal, reveal, restoring = false } = {}) {
        if (!available() || connecting || signal?.aborted) return { ok: false, reason: 'busy' }
        const origin = normalizeHubOrigin(address)
        if (!origin) return { ok: false, reason: 'invalid' }
        const controller = new AbortController()
        connecting = controller
        const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        try {
            const desktopSession = session.fromPartition(hubPartition(origin))
            const result = await checkHub(origin, version, desktopSession.fetch.bind(desktopSession),
                AbortSignal.any([lifetime, AbortSignal.timeout(8000)]))
            let issue = null
            if (!result.ok) {
                if (result.reason === 'unreachable' && await savedOrigin() === origin) issue = { reason: 'offline' }
                else if (restoring && result.reason === 'too-old') issue = { reason: result.reason, minimum: result.minimum }
                else return result
            }
            if (!available() || (parent && picker !== parent)) return { ok: false, reason: 'busy' }
            const request = parent ? pendingOpen : null
            const opening = AbortSignal.any([lifetime, AbortSignal.timeout(25000)])
            if (!await openHub(origin, desktopSession, request?.path ?? path, opening, issue, undefined, reveal)) {
                return { ok: false, reason: 'unreachable' }
            }
            if (request && pendingOpen === request) pendingOpen = null
            // The connection is usable even if the convenience of remembering its address fails.
            if (remember) await atomicPrivateJSON(file, { origin }).then(() => onConnect?.(), () => {})
            if (parent && !parent.isDestroyed()) {
                acceptedPicker = parent
                setTimeout(() => { if (!parent.isDestroyed()) parent.close() }, 0)
            }
            return { ok: true }
        } catch { return { ok: false, reason: 'unreachable' } }
        finally {
            if (connecting === controller) connecting = null
            if (!picker && pendingOpen) void openPendingLink()
        }
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
        if (localSender(event)) {
            event.returnValue = { audience: 'picker', copy: hubPickerCopy(pickerLocale) }
            return
        }
        const offline = offlineSender(event)
        if (offline) {
            offline.locale = language(offline.origin)
            event.returnValue = { audience: 'hub-offline', copy: hubOfflineCopy(offline.locale),
                appearance: offline.appearance ?? systemAppearance(),
                appStore: process.mas === true, updatesAvailable: updates?.enabled() === true }
            return
        }
        if (quickAsk.sender(event)) {
            event.returnValue = { audience: 'hub-quick-ask', ...shellIdentity, shortcut: QUICK_ASK_SHORTCUT }
            return
        }
        const entry = hubSender(event)
        if (!entry || !available()) { event.returnValue = null; return }
        invalidateNative(entry)
        entry.native = { frame: event.senderFrame, id: randomUUID(), unread: 0, workspaceId: null }
        event.returnValue = { audience: 'hub', ...shellIdentity, capabilities: updates?.enabled() ? [...capabilities, 'update'] : capabilities }
    })
    ipcMain.handle('hub:quick-ask-close', event => quickAsk.close(quickAsk.sender(event)))
    ipcMain.handle('hub:quick-ask-sent', (event, path) => quickAsk.sent(quickAsk.sender(event), path))
    ipcMain.handle('hub:saved-origin', event => localSender(event) ? savedOrigin() : null)
    async function connectFromPicker(event, address) {
        if (!localSender(event)) return { ok: false, reason: 'invalid' }
        const locale = pickerLocale
        const result = await connect(address, { parent: picker })
        return result.ok ? result : { ...result, message: hubConnectionError(locale, result) }
    }
    ipcMain.handle('hub:connect', connectFromPicker)
    ipcMain.handle('hub:connect-cloud', event => connectFromPicker(event, RERUN_CLOUD_ORIGIN))
    ipcMain.handle('hub:offline-state', event => {
        const entry = offlineSender(event)
        return entry ? hubRecoveryView(entry.locale, entry.recovery.state()) : null
    })
    ipcMain.handle('hub:offline-retry', async event => {
        const entry = offlineSender(event)
        return entry ? hubRecoveryView(entry.locale, await entry.recovery.retry()) : null
    })
    ipcMain.handle('hub:offline-download', event => {
        const entry = incompatibleSender(event)
        if (process.mas || !entry?.window.isVisible() || !entry.window.isFocused()) return false
        return shell.openExternal(downloadPage).then(() => true, () => false)
    })
    ipcMain.handle('hub:offline-update-state', event =>
        updates?.enabled() && incompatibleSender(event) ? updateState(updates.state()) : null)
    ipcMain.handle('hub:offline-update-check', async event => {
        if (updates?.enabled() && incompatibleSender(event)) await updates.checkForUpdates(false)
    })
    ipcMain.handle('hub:offline-update-install', event => {
        const entry = incompatibleSender(event)
        if (!updates?.enabled() || !entry?.window.isVisible() || !entry.window.isFocused()) return false
        const frame = event.senderFrame
        const scope = entry.scope
        return updates.offerInstall({ parent: entry.window, isCurrent: () =>
            entry.scope === scope && entry.contents.mainFrame === frame && incompatibleSender(event) === entry
            && entry.window.isVisible() && canRestartForUpdate() })
    })
    for (const [channel, action] of [
        ['hub:window-state', entry => stateOf(entry.window)],
        ['hub:window-chrome', (entry, colors, frame) => {
            if (!entry.native || entry.native.frame !== frame || !currentNative(entry, entry.native)) return
            const symbol = colors?.symbolColor
            if (opaqueColor(symbol)) {
                // Upstream sends a dark symbol for a light board and a light symbol for a dark board.
                const appearance = parseInt(symbol.slice(1, 3), 16) > 0x80 ? 'dark' : 'light'
                if (entry.appearance !== appearance) {
                    entry.appearance = appearance
                    if (entry.primary) appearanceWrites = appearanceWrites
                        .then(() => atomicPrivateJSON(appearancePath(entry.origin), { version: 1, appearance }))
                        .catch(() => console.warn('Could not save the connected Rerun appearance.'))
                }
                entry.window.setBackgroundColor(backgroundFor(appearance))
            }
            if (opaqueColor(colors?.frameColor)) entry.window.setBackgroundColor(colors.frameColor)
        }],
        ['hub:find', entry => openFind(entry.window)],
        ['hub:open-link', async (entry, url, frame, registrationId) => (await serviceSignIn.consider(entry, url, registrationId, frame)) ? true : external(url)],
        ['hub:oauth-cancel', (entry, registrationId, frame) => serviceSignIn.cancel(entry, registrationId, frame)],
        ['hub:show-download', (entry, id) => downloads.show(entry, id)],
        ['hub:settings', () => desktopSettings()],
        ['hub:locale', (entry, value, frame) => {
            if (entry.native?.frame === frame && currentNative(entry, entry.native)) setLanguage(entry.origin, value)
        }],
        ['hub:set-settings', (entry, value, frame) => {
            const native = entry.native
            const assertCurrent = () => {
                if (native?.frame !== frame || !currentNative(entry, native)) throw new Error('The connected Rerun page changed')
            }
            assertCurrent()
            return changeDesktopSettings(value, assertCurrent)
        }],
        ['hub:notify', (entry, value, frame) => notify(entry, value, frame)],
        ['hub:badge', (entry, count, frame, workspace) => {
            if (entry.native?.frame !== frame || !Number.isSafeInteger(count) || count < 0) return
            const unread = Math.min(count, 9999)
            const workspaceId = parseHubWorkspaceId(workspace)
            if (entry.native.unread === unread && entry.native.workspaceId === workspaceId) return
            entry.native.unread = unread
            entry.native.workspaceId = workspaceId
            publishUnread()
        }],
        ['hub:open-picker', () => openPicker()],
        ['hub:auth-start', (entry, options) => entry.auth.start(options?.provider)],
        ['hub:auth-code', (entry, code) => redeem(entry, code)],
    ]) ipcMain.handle(channel, (event, value, registrationId) => {
        const entry = hubSender(event)
        if (!entry || !available()) throw new Error('Untrusted Rerun hub request')
        return action(entry, value, event.senderFrame, registrationId)
    })
    function updateSender(event) {
        const entry = hubSender(event)
        return updates?.enabled() && entry?.native && entry.native.frame === event.senderFrame
            && currentNative(entry, entry.native) ? entry : null
    }
    ipcMain.handle('hub:update-state', event => updateSender(event) ? updateState(updates.state()) : null)
    ipcMain.handle('hub:update-check', async event => {
        if (updateSender(event)) await updates.checkForUpdates(false)
    })
    ipcMain.handle('hub:update-install', event => {
        const entry = updateSender(event)
        if (!entry || !entry.window.isFocused() || !entry.window.isVisible()) return false
        const native = entry.native
        return updates.offerInstall({ parent: entry.window,
            isCurrent: () => currentNative(entry, native) && entry.window.isVisible() && canRestartForUpdate() })
    })

    return {
        publishUpdate(state) {
            if (!updates?.enabled()) return
            const value = updateState(state)
            for (const entry of windows.values()) {
                try {
                    const frame = entry.contents.mainFrame
                    const offline = frame && incompatibleSender({ sender: entry.contents, senderFrame: frame })
                    if (offline) frame.send('hub:offline-update-changed', value)
                    else if (entry.native && currentNative(entry, entry.native)) entry.native.frame.send('hub:update-state', value)
                } catch { /* A renderer can close before delivery. */ }
            }
        },
        openPicker,
        openCloud: () => connect(RERUN_CLOUD_ORIGIN),
        async reopenRemembered(options) {
            const origin = await savedOrigin()
            if (!origin || !available() || picker || openingLink || pendingOpen || connecting) return false
            return (await connect(origin, { ...options, remember: false, restoring: true })).ok
        },
        ownsWindow: window => !!entryFor(window),
        focusWindow(window) {
            if (!available() || !entryFor(window)) return false
            show(window)
            return true
        },
        languageScopeOf: window => entryFor(window)?.origin ?? null,
        scopeOf: window => available() ? connected(window)?.scope : null,
        duplicateWindow(window) {
            const entry = entryFor(window)
            if (!entry) return false
            if (available()) void duplicateHub(entry).catch(() => {})
            return true
        },
        reloadWindow(window) {
            const entry = entryFor(window)
            if (!entry) return false
            if (available() && entry.recovery.onOfflinePage()) {
                const frame = entry.contents.mainFrame
                void entry.recovery.retry().then(issue => {
                    if (issue && available() && entry.recovery.onOfflinePage() && entry.contents.mainFrame === frame) {
                        frame.send('hub:offline-state-changed', hubRecoveryView(entry.locale, issue))
                    }
                }).catch(() => {})
            } else if (available() && connected(window) && !entry.contents.isLoadingMainFrame()) {
                entry.contents.reload()
            }
            return true
        },
        toggleQuickAsk(window, { background = false } = {}) {
            if (background && (!window || window.isDestroyed()) && !picker && !connecting) {
                // A login launch can restore a hub without any window taking focus.
                // Do not guess which server to use when more than one is open.
                const primary = [...windows.values()].filter(entry => entry.primary && !entry.window.isDestroyed())
                if (primary.length === 1 && !primary[0].window.isVisible()) window = primary[0].window
            }
            const entry = connected(window)
            if (entry && !singleQuickAskReceiver(entry)) {
                void dialog.showMessageBox(window, { type: 'info', title: 'Quick Ask',
                    message: 'Close the other windows for this Rerun server to use Quick Ask here.', buttons: ['OK'] }).catch(() => {})
                return true
            }
            return quickAsk.toggle(window, entry)
        },
        resetQuickAsk: () => quickAsk.reset(),
        async openLink(link) {
            if (!available()) return
            if (link.kind === 'auth') {
                const entry = [...windows.values()].find(value => connected(value.window) && value.auth.matches(link.state))
                if (entry) await redeem(entry, link.code, link.state)
                return
            }
            if (link.kind === 'oauth') {
                await serviceSignIn.complete(link.result)
                return
            }
            pendingOpen = { path: link.path }
            await openPendingLink()
        },
        async closeAll() {
            serviceSignIn.cancelAll()
            pendingOpen = null
            connecting?.abort()
            quickAsk.reset()
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
            await appearanceWrites
        },
    }
}
