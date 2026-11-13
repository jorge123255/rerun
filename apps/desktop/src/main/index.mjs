import * as electron from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWorkspaceCoordinator, seedLegacyCatalog, getWorkspace } from './workspaces/index.mjs'
import { DesktopSecureStorageError, loadBundle, loadIdentityFromSafeStorage, workspaceIdentity } from './runtime.mjs'
import { RuntimeSupervisor } from './supervisor.mjs'
import { createDesktopNotifications } from './notifications.mjs'
import { createNotificationClickHandoff } from './notification-click-handoff.mjs'
import { completeDesktopQuit } from './before-quit.mjs'
import { createDesktopTemplateFiles } from './templates.mjs'
import { createDesktopCoworkerShareFiles } from './coworker-share-files.mjs'
import { createNativeRemoteMachines } from './remote-machines/binding.mjs'
import { createRemoteMachineIpc } from './remote-machines/ipc.mjs'
import { desktopMicrophonePermissions } from './media-permissions.mjs'
import { createDesktopFileSaves, safeDisplayedImageError } from './result-files.mjs'
import { installMacApplicationMenu } from './application-menu.mjs'
import { approvedQuitAction, BUILD_RELEASE, createMacUpdater } from './mac-updates.mjs'
import { loadShellLanguage, shellText } from './shell-language.mjs'
import { createMacMenuBar, macLoginItemSettings, setMacOpenAtLogin } from './mac-menu-bar.mjs'
import { attachDesktopContextMenu, externalDesktopLink } from './window-context-menu.mjs'
import { createWindowFind } from './window-find.mjs'
import { createQuickAskWindow } from './quick-ask-window.mjs'
import { loadQuickAskShortcut } from './quick-ask-shortcut.mjs'
import { cascadeWindowBounds, createBoardWindows } from './board-windows.mjs'
import { captureWindowPlacement, createWindowPlacements, restoreWindowZoom } from './window-placement.mjs'
import { hideWorkspaceWindow, revealWorkspaceWindow } from './window-visibility.mjs'
import { createConnectedHubs } from './connected-hubs.mjs'
import { hubConnectionError } from './connected-hub-messages.mjs'
import { parseHubLink, registerHubProtocol } from './connected-hub-policy.mjs'
import { configureStartupProfile, hasLocalWorkspace, loadStartupWorkspace } from './startup-workspace.mjs'
import { createMacPhonePairingService } from './mac-phone-pairing/index.mjs'
import { pairingQrImage } from './mac-phone-pairing/qr.mjs'
import { createPhonePairingWindow } from './mac-phone-pairing-window.mjs'

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, shell, session, Tray, WebContentsView } = electron
const directory = fileURLToPath(new URL('.', import.meta.url))
const resources = app.isPackaged ? process.resourcesPath : resolve(directory, '../../resources')
const startup = resolve(directory, 'startup.html')
const mac = process.platform === 'darwin'
let dataRoot
let windowPlacements
const boardPlacement = 'local-board'
let storageSetupError
let window
let menuBar
let shellLanguage
let shortcutPreference
let lastWorkspaceWindow
let saveBoardPlacement
let showWindowOnReady = true
let supervisor
let runtime
let workspaces
let remoteMachines
let remoteInstallId
const remoteClosures = new Map()
let activeSession
let activeWorkspaceId
let connectedHubs
let pendingHubLink
let reopeningHub
let transitioning = false
let quitting = false
let quittingNow = false
let phonePairing
let openingLocalWorkspace
let startupWorkspace
let bootStatus = { state: 'starting', message: 'Preparing local runtime…' }
const profile = 'persist:rerun-desktop-local'
const boards = createBoardWindows({ startupUrl: pathToFileURL(startup).href, isDesktopPage })
const rendererCrashInterval = 60_000
const rendererFailureStatus = { state: 'error', message: 'The workspace window closed unexpectedly. Try reopening it.' }
const changingBoards = new Set()
const phonePairingWindow = createPhonePairingWindow({ BrowserWindow })
const quickAsk = createQuickAskWindow({ app, BrowserWindow, screen, showBoard: showMainWindow,
    language: () => shellLanguage?.forScope('local'), boardScope: () =>
    boardContext(window) ? { epoch: boards.get(window).epoch, contents: window.webContents } : null,
})
const windowFind = createWindowFind({ WebContentsView, scopeOf: candidate => boardContext(candidate)?.rendererEpoch ?? connectedHubs?.scopeOf(candidate),
    language: candidate => shellLanguage?.forScope(connectedHubs?.languageScopeOf(candidate) ?? 'local'),
    topInset: candidate => mac && !candidate.isFullScreen() ? 28 : 0,
})
function boardContext(candidate) {
    const entry = boards.get(candidate)
    if (quitting || transitioning || changingBoards.has(candidate) || !runtimeScope() || !boards.ready(entry, runtime)) return null
    return { runtime, window: candidate, rendererEpoch: entry.epoch }
}
const filesFor = candidate => createDesktopFileSaves({ dialog, context: () => boardContext(candidate) })
const templatesFor = candidate => createDesktopTemplateFiles({ dialog, context: () => boardContext(candidate) })
const sharesFor = candidate => createDesktopCoworkerShareFiles({ dialog, context: () => boardContext(candidate) })
const remoteMachineIpc = createRemoteMachineIpc({ trusted: trustedPrimary, context: () => {
    const current = supervisor?.runtime
    if (quitting || transitioning || !remoteMachines || !runtime || runtime !== current || supervisor.status.state !== 'ready'
        || remoteClosures.has(current.workspaceId) || !boards.ready(boards.get(window), current)) return null
    return { binding: remoteMachines, actor: { installId: remoteInstallId, workspaceId: current.workspaceId,
        launchNonce: current.launchNonce, rendererEpoch: boards.get(window).epoch } }
} })
const clickHandoff = createNotificationClickHandoff()
let clickReady = null
let desktopNotifications = createNotices()
let localUnread = 0
let hubUnread = 0
function startupChoices(includeLocal = true) {
    const t = shellText(shellLanguage?.forScope('local'))
    return {
        ...(includeLocal ? { local: t('startup.runLocally') } : {}),
        cloud: t('startup.signInCloud'), connect: t('startup.connectServer'),
        connecting: t('server.connecting'), unreachable: t('server.unreachable'),
    }
}
function publishBootStatus(status) {
    bootStatus = status
    if (window && !window.isDestroyed()) window.webContents.send('desktop:status', bootStatus)
}
function workspaceChoiceStatus() {
    const t = shellText(shellLanguage?.forScope('local'))
    return { state: 'choose', message: t('startup.chooseWorkspace'), choices: startupChoices() }
}
function leaveLocalUnlock() {
    if (bootStatus.state !== 'keychain') return
    openingLocalWorkspace?.abort()
    openingLocalWorkspace = null
    publishBootStatus(workspaceChoiceStatus())
}
function reportStartupError(error) {
    const secureStorageBlocked = mac && error instanceof DesktopSecureStorageError
    if (supervisor) supervisor.publish('error', 'Workspace state could not be verified. Restore the workspace state before retrying.')
    else if (secureStorageBlocked) {
        const t = shellText(shellLanguage?.forScope('local'))
        publishBootStatus({ state: 'error', message: t('startup.keychainBlocked'), choices: startupChoices(false),
            retryLabel: t('startup.restartToRetry') })
    } else publishBootStatus({ state: 'error', message: 'Desktop setup failed. Check that this app has a complete bundled runtime and access to secure storage.' })
}
function showMainWindow() {
    showWindowOnReady = true
    revealWorkspaceWindow(window)
}
function reopenRememberedHub() {
    if (!reopeningHub) {
        const controller = new AbortController()
        const promise = connectedHubs.reopenRemembered({
            signal: controller.signal, reveal: () => showWindowOnReady,
        }).catch(() => false).finally(() => { if (reopeningHub?.controller === controller) reopeningHub = null })
        reopeningHub = { controller, promise }
    }
    return reopeningHub.promise
}
function showWorkspaceWindow() {
    if (quitting) return
    showWindowOnReady = true
    for (const candidate of [BrowserWindow.getFocusedWindow(), lastWorkspaceWindow]) {
        if (connectedHubs?.focusWindow(candidate)) return
        if (boardContext(candidate)) { revealWorkspaceWindow(candidate); return }
    }
    if (connectedHubs && bootStatus.state === 'choose' && !openingLocalWorkspace && !supervisor) {
        void reopenRememberedHub().then(opened => {
            if (!opened && !quitting && !openingLocalWorkspace) showMainWindow()
        })
    } else showMainWindow()
}
function publishMacUnread() {
    if (process.platform !== 'darwin') return
    const count = Math.min(localUnread + hubUnread, 9999)
    app.setBadgeCount(count)
    try { menuBar?.setUnread(count) }
    catch { console.warn('Could not update the Rerun menu-bar item.') }
}
function setMacUnread(count) {
    localUnread = count
    publishMacUnread()
}
function toggleQuickAsk() {
    const focused = BrowserWindow.getFocusedWindow() ?? lastWorkspaceWindow
    if (connectedHubs?.toggleQuickAsk(focused)) quickAsk.reset()
    else quickAsk.toggle()
}
function desktopSettings() {
    return { quickAsk: shortcutPreference.state().enabled, closeToTray: true, openAtLogin: macLoginItemSettings(app)?.openAtLogin === true }
}
async function changeDesktopSettings(patch, assertCurrent) {
    if (typeof patch?.quickAsk === 'boolean') {
        try { await shortcutPreference.change(patch.quickAsk, assertCurrent) }
        catch { assertCurrent(); return desktopSettings() }
    }
    assertCurrent()
    setMacOpenAtLogin(app, patch?.openAtLogin)
    return desktopSettings()
}
function openExternal(href) {
    const url = externalDesktopLink(href)
    if (url) void shell.openExternal(url).catch(() => {})
}
function reportImageSaveFailure(candidate, error) {
    const options = { type: 'warning', title: 'Save Image', message: safeDisplayedImageError(error), buttons: ['OK'], defaultId: 0, noLink: true }
    const parent = candidate && !candidate.isDestroyed() ? candidate : null
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).catch(() => {})
}
function focusedBoard() {
    const focused = BrowserWindow.getFocusedWindow()
    return boards.get(focused) ? focused : window
}
async function confirmDiscard(candidate, action) {
    const options = {
        type: 'warning', title: 'Unsaved changes',
        message: 'Some changes haven’t been saved.',
        detail: 'Stay in Rerun to review or save your changes.',
        buttons: ['Stay', action + ' without saving'], defaultId: 0, cancelId: 0, noLink: true,
    }
    const parent = candidate && !candidate.isDestroyed() ? candidate : null
    revealWorkspaceWindow(parent)
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return result.response === 1
}
function runtimeScope() {
    const current = supervisor?.runtime
    if (!current || !runtime || runtime !== current || supervisor.status.state !== 'ready') return null
    return { workspaceId: current.workspaceId, launchNonce: current.launchNonce }
}
function clickScope() {
    if (quitting || transitioning) return null
    return runtimeScope()
}
function flushNotificationClicks() {
    clickHandoff.flush(clickScope(), target => {
        if (quitting || transitioning || !boards.ready(boards.get(window), runtime)) return false
        if (!clickReady || clickReady.contents !== window.webContents) return false
        window.webContents.send('desktop:notification-click', target)
        return true
    })
}
function createNotices() { return createDesktopNotifications({ Notification, onClick: (target, scope) => {
    const current = clickScope()
    if (!scope || !current || scope.workspaceId !== current.workspaceId || scope.launchNonce !== current.launchNonce) return
    showMainWindow()
    // Bind the click to the runtime that originally submitted the notice, even after reload.
    clickHandoff.accept(target, scope)
    flushNotificationClicks()
} }) }

let refreshUpdateSurfaces = () => {}
const macUpdates = mac && !process.mas ? createMacUpdater({
    autoUpdater: electron.autoUpdater, app, dialog, release: { ...BUILD_RELEASE, packaged: app.isPackaged },
    getWindow: () => BrowserWindow.getFocusedWindow() ?? focusedBoard(),
    text: () => shellText(shellLanguage?.locale()),
    onState: () => refreshUpdateSurfaces(),
}) : null

try {
    dataRoot = configureStartupProfile(app)
    windowPlacements = mac ? createWindowPlacements({ dataRoot, screen }) : null
} catch (error) { storageSetupError = error }

if (storageSetupError) {
    dialog.showErrorBox('Rerun could not start', 'Check that Rerun can open its data folder and try again.')
    app.exit(1)
} else if (!app.requestSingleInstanceLock()) app.quit()
else {
    if (mac) app.on('open-url', (event, address) => {
        const link = parseHubLink(address)
        if (!link) return
        event.preventDefault()
        if (link.kind === 'open') reopeningHub?.controller.abort()
        if (connectedHubs) void connectedHubs.openLink(link).catch(() => {})
        else if (link.kind === 'open') pendingHubLink = link
    })
    app.on('second-instance', showWorkspaceWindow)
    app.on('activate', showWorkspaceWindow)
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
    app.on('before-quit', event => {
        if (quittingNow) return
        event.preventDefault()
        if (quitting || transitioning || changingBoards.size) return
        quitting = true
        for (const board of boards.list()) windowFind.close(board.window)
        quickAsk.reset()
        void completeDesktopQuit({
            flush: () => boards.flushAll(runtime),
            confirmDiscard: () => confirmDiscard(focusedBoard(), 'Quit'),
            stop: async () => {
                openingLocalWorkspace?.abort()
                await connectedHubs?.closeAll()
                await shortcutPreference?.flush()
                await remoteMachines?.close()
                phonePairingWindow.close()
                await phonePairing?.stop()
                await supervisor?.stop()
                saveBoardPlacement?.()
                await windowPlacements?.flush()
                await shellLanguage?.flush()
                await startupWorkspace?.flush()
            },
            quit: () => { clickHandoff.stop(); quittingNow = true; approvedQuitAction(macUpdates, app) },
            cancelled: resumeAfterCancelledQuit,
        }).catch(() => { if (!quittingNow) resumeAfterCancelledQuit() })
    })
    app.whenReady().then(launch).catch(reportStartupError)
}

function trusted(event) {
    return boards.trusted(event, runtime)
}

function trustedPrimary(event) {
    const entry = trusted(event)
    if (!entry.primary || entry.window !== window) throw new Error('This operation requires the main workspace window')
    return entry
}

function isDesktopPage(href) {
    if (!runtime) return false
    try {
        const url = new URL(href)
        return url.origin === runtime.app.origin && url.pathname === '/desktop'
    } catch { return false }
}

function resumeAfterCancelledQuit() {
    quitting = false
    // The renderer stays frozen after an ACK, until shutdown or this explicit cancellation.
    for (const board of boards.list()) resumeBoard(board)
    flushNotificationClicks()
}

function resumeBoard(board) {
    try { if (boards.ready(board, runtime)) board.contents.send('desktop:quit-cancelled') } catch {}
}

async function launch() {
    const openRememberedHub = !pendingHubLink
    if (mac) {
        startupWorkspace = await loadStartupWorkspace(dataRoot)
        if (app.isPackaged && !registerHubProtocol(app)) console.warn('Could not register Rerun development links with macOS.')
        shortcutPreference = await loadQuickAskShortcut({ dataRoot, globalShortcut, open: toggleQuickAsk })
        const currentLanguageScope = () => {
            const focused = BrowserWindow.getFocusedWindow()
            if (boards.get(focused)) return 'local'
            return connectedHubs?.languageScopeOf(focused) ?? connectedHubs?.languageScopeOf(lastWorkspaceWindow) ?? 'local'
        }
        shellLanguage = await loadShellLanguage({ dataRoot,
            systemLanguages: [...app.getPreferredSystemLanguages(), app.getLocale()], currentScope: currentLanguageScope,
            onChange: () => { refreshApplicationMenu(); menuBar?.refresh() } })
        connectedHubs = createConnectedHubs({ app, BrowserWindow, Menu, clipboard, Notification, ipcMain, session, shell, dialog, screen, dataRoot, windowPlacements,
            updates: macUpdates, canRestartForUpdate: () => !transitioning && !changingBoards.size,
            available: () => !quitting, openFind: candidate => windowFind.open(candidate), closeFind: candidate => windowFind.close(candidate),
            setUnread: count => { hubUnread = count; publishMacUnread() }, desktopSettings, changeDesktopSettings,
            setLanguage: (scope, locale) => shellLanguage.set(scope, locale), language: scope => shellLanguage.forScope(scope),
            onConnect: () => startupWorkspace.remember('connected'),
            systemAppearance: () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light' })
        app.on('browser-window-focus', (_event, candidate) => {
            const hub = connectedHubs.ownsWindow(candidate)
            if (boards.get(candidate) || hub) {
                if (hub || boardContext(candidate)) lastWorkspaceWindow = candidate
                shellLanguage.select(connectedHubs.languageScopeOf(candidate) ?? 'local')
            }
        })
        if (pendingHubLink) {
            const link = pendingHubLink
            pendingHubLink = null
            void connectedHubs.openLink(link).catch(() => {})
        }
        app.once('will-quit', shortcutPreference.unregister)
        const refreshApplicationMenu = () => installMacApplicationMenu({
            Menu, appName: app.name, isDesktopPage, locale: shellLanguage.locale(),
            settingsWindow: () => {
                const candidate = focusedBoard()
                return boardContext(candidate) && boards.get(candidate).drafts.ready ? candidate : null
            },
            openDocumentation: () => openExternal('https://docs.rerun.build'),
            openFind: () => {
                const focused = BrowserWindow.getFocusedWindow()
                windowFind.open(connectedHubs.scopeOf(focused) ? focused : focusedBoard())
            },
            openQuickAsk: toggleQuickAsk,
            openLocalWorkspace: () => {
                showMainWindow()
                if (runtimeScope()) void startupWorkspace.remember('local')
                else if (bootStatus.state === 'choose') void openLocalWorkspace()
            },
            openNewWindow: (_item, candidate) => {
                const focused = candidate ?? BrowserWindow.getFocusedWindow() ?? lastWorkspaceWindow
                if (connectedHubs.duplicateWindow(focused)) return
                void openAdditionalBoard().catch(() => {})
            },
            openHubPicker: () => { reopeningHub?.controller.abort(); leaveLocalUnlock(); connectedHubs.openPicker() },
            openPhonePairing: () => phonePairingWindow.open(),
            reloadWindow: (_item, candidate) => {
                const last = lastWorkspaceWindow && !lastWorkspaceWindow.isDestroyed() ? lastWorkspaceWindow : window
                const target = candidate ?? BrowserWindow.getFocusedWindow() ?? last
                if (!connectedHubs.reloadWindow(target)) void reloadBoard(target).catch(() => {})
            },
            devTools: !app.isPackaged,
            checkForUpdates: macUpdates ? () => { void macUpdates.checkFromMenu() } : undefined,
            updateItem: macUpdates?.menuItem(),
        })
        refreshApplicationMenu()
        try {
            menuBar = createMacMenuBar({ app, Menu, Tray, nativeImage, openWindow: showWorkspaceWindow, locale: shellLanguage.locale, updates: macUpdates,
                quickAsk: { enabled: () => shortcutPreference.state().enabled, open: toggleQuickAsk } })
            showWindowOnReady = !menuBar.startedAtLogin
        } catch {
            console.warn('Could not start the Rerun menu-bar item.')
        }
        if (macUpdates) {
            refreshUpdateSurfaces = () => {
                refreshApplicationMenu()
                try { menuBar?.refresh() } catch { /* The menu bar is optional. */ }
                const state = macUpdates.state()
                connectedHubs.publishUpdate(state)
                for (const board of boards.list()) {
                    try { if (boards.ready(board, runtime)) board.contents.send('desktop:update-state', state) } catch {}
                }
            }
            macUpdates.start({ scheduleChecks: true })
        }
    }
    await prepareWorkspaceWindow(1, false)
    ipcMain.handle('desktop:status', event => {
        if (boards.recoveryPage(event, runtime)) return rendererFailureStatus
        trusted(event)
        return supervisor?.status ?? bootStatus
    })
    if (mac) {
        const onStartupPage = event => {
            trustedPrimary(event)
            return event.senderFrame.url === pathToFileURL(startup).href && !quitting
        }
        const canConnectToServer = event => onStartupPage(event) && !!bootStatus.choices && !supervisor
        ipcMain.handle('desktop:startup-local', event => onStartupPage(event) && bootStatus.state === 'choose' && openLocalWorkspace())
        ipcMain.handle('desktop:startup-cloud', async event => {
            if (!canConnectToServer(event)) return { ok: false }
            const restore = reopeningHub
            restore?.controller.abort()
            await restore?.promise
            if (!canConnectToServer(event)) return { ok: false }
            leaveLocalUnlock()
            const locale = shellLanguage.forScope('local')
            const result = await connectedHubs.openCloud()
            return result.ok ? result : { ...result, message: hubConnectionError(locale, result) }
        })
        ipcMain.handle('desktop:startup-connect', event => {
            if (!canConnectToServer(event)) return false
            reopeningHub?.controller.abort()
            leaveLocalUnlock()
            connectedHubs.openPicker()
            return true
        })
        ipcMain.on('desktop:find-open', event => {
            try { windowFind.open(trusted(event).window) } catch { /* Ignore untrusted frames. */ }
        })
        ipcMain.on('desktop:find-query', (event, input) => windowFind.search(event, input))
        ipcMain.on('desktop:find-close', event => windowFind.dismiss(event))
        ipcMain.on('desktop:language', (event, value) => {
            try {
                const board = trusted(event)
                if (boardContext(board.window)) shellLanguage.set('local', value)
            } catch { /* Ignore untrusted frames. */ }
        })
        ipcMain.handle('desktop:mac-fullscreen', event => (boards.recoveryPage(event, runtime) ?? trusted(event)).window.isFullScreen())
        const assertBoard = event => {
            trusted(event)
            if (quitting || transitioning || !runtimeScope() || !isDesktopPage(event.senderFrame.url)) throw new Error('The workspace is unavailable')
        }
        const localMacSettings = () => ({
            openAtLogin: macLoginItemSettings(app)?.openAtLogin ?? null,
            version: app.isPackaged ? app.getVersion() : null,
            updatesAvailable: macUpdates?.enabled() === true,
        })
        ipcMain.handle('desktop:mac-settings', event => { assertBoard(event); return localMacSettings() })
        ipcMain.handle('desktop:mac-set-open-at-login', (event, enabled) => {
            assertBoard(event)
            setMacOpenAtLogin(app, enabled)
            return localMacSettings()
        })
        ipcMain.handle('desktop:update-state', event => { assertBoard(event); return macUpdates?.state() ?? { status: 'idle' } })
        ipcMain.handle('desktop:update-check', event => { assertBoard(event); return macUpdates?.checkForUpdates(false) ?? { status: 'idle' } })
        ipcMain.handle('desktop:update-install', event => {
            assertBoard(event)
            if (changingBoards.size) return false
            return macUpdates?.requestRestart() ?? false
        })
        ipcMain.handle('desktop:quick-ask-settings', event => { assertBoard(event); return shortcutPreference.state() })
        ipcMain.handle('desktop:quick-ask-set-shortcut', (event, enabled) => {
            assertBoard(event)
            return shortcutPreference.change(enabled, () => assertBoard(event))
        })
        ipcMain.handle('desktop:quick-ask-send', (event, text) => quickAsk.send(event, text))
        ipcMain.on('desktop:quick-ask-close', event => quickAsk.close(event))
        for (const [channel, action] of [
            ['desktop:quick-ask-ready', (event, value) => quickAsk.register(event, value, boards.get(window).epoch)],
            ['desktop:quick-ask-unready', quickAsk.unregister],
            ['desktop:quick-ask-ack', quickAsk.acknowledge],
        ]) {
            ipcMain.on(channel, (event, value) => {
                try { trustedPrimary(event); if (isDesktopPage(event.senderFrame.url)) action(event, value) } catch {}
            })
        }
    }
    ipcMain.handle('desktop:retry', async event => {
        const board = boards.recoveryPage(event, runtime)
        if (board) {
            if (!canRecoverBoard(board, runtime)) return false
            return reopenBoardRenderer(board, board.rendererCrash)
        }
        trustedPrimary(event)
        if (event.senderFrame.url !== pathToFileURL(startup).href || transitioning || quitting || changingBoards.size) return false
        if (!supervisor) {
            if (bootStatus.state !== 'error') return false
            // Electron caches the asynchronous encryptor for this process, including a refused Keychain key.
            app.relaunch()
            app.quit()
            return true
        }
        if (!workspaces) return false
        if (['starting', 'stopping'].includes(supervisor.status.state)) return false
        const pending = (await workspaces.reconcile()).openReceipt
        if (pending) return runWorkspaceTransition(() => workspaces.recoverSwitch({ requestId: pending.requestId, workspaceId: pending.toWorkspaceId }))
        await closeRemoteWorkspace(supervisor.runtime?.workspaceId)
        retireAdditionalBoards()
        runtime = null
        await window.loadFile(startup)
        await supervisor.stop()
        await startWorkspace()
        return true
    })
    ipcMain.handle('desktop:workspaces-list', event => { trusted(event); return workspaces.list() })
    ipcMain.handle('desktop:workspaces-reconcile', event => { trusted(event); return workspaces.reconcile() })
    for (const [channel, operation] of [['desktop:workspaces-create', 'create'], ['desktop:workspaces-rename', 'rename']]) {
        ipcMain.handle(channel, (event, input) => {
            trusted(event)
            if (quitting || transitioning || !isDesktopPage(event.senderFrame.url)) return { ok: false, code: 'busy', message: 'Wait for this workspace change to finish.' }
            return workspaces[operation](input)
        })
    }
    ipcMain.handle('desktop:workspaces-switch', (event, input) => {
        trusted(event)
        if (quitting || transitioning || !isDesktopPage(event.senderFrame.url)) return { ok: false, code: 'busy', message: 'Wait for this workspace change to finish.' }
        return runWorkspaceTransition(() => workspaces.switchTo(input))
    })
    ipcMain.handle('desktop:workspaces-recover', (event, input) => {
        trusted(event)
        if (quitting || transitioning) return { ok: false, code: 'busy', message: 'Wait for this workspace change to finish.' }
        return runWorkspaceTransition(() => workspaces.recoverSwitch(input))
    })
    ipcMain.handle('desktop:quit', event => {
        if (!boards.recoveryPage(event, runtime)) trusted(event)
        app.quit()
    })
    const trustedPhonePairing = (event, readOnly = false) => {
        if (!phonePairingWindow.isTrusted(event) || (!readOnly && quitting)) throw new Error('Phone pairing is unavailable.')
        if (!phonePairing) throw new Error('Open a local workspace before pairing an iPhone.')
        return phonePairing
    }
    ipcMain.handle('desktop:phone-pairing-status', event => trustedPhonePairing(event, true).status())
    ipcMain.handle('desktop:phone-pairing-enable', (event, enabled) => trustedPhonePairing(event).setPhoneAccessEnabled(enabled === true))
    ipcMain.handle('desktop:phone-pairing-network', (event, address) => trustedPhonePairing(event).setLanAddress(address))
    ipcMain.handle('desktop:phone-pairing-offer', async event => {
        const offer = await trustedPhonePairing(event).createOffer()
        const qr = await pairingQrImage(resources, offer)
        trustedPhonePairing(event)
        return { offer, qr }
    })
    ipcMain.handle('desktop:phone-pairing-approve', (event, deviceId) => trustedPhonePairing(event).approveDevice(deviceId))
    ipcMain.handle('desktop:phone-pairing-send-permission', (event, deviceId, enabled) => trustedPhonePairing(event).setSendMessages(deviceId, enabled === true))
    ipcMain.handle('desktop:phone-pairing-revoke', (event, deviceId) => trustedPhonePairing(event).revokeDevice(deviceId))
    ipcMain.handle('desktop:remote-machines-actor', event => remoteMachineIpc.actor(event))
    ipcMain.handle('desktop:remote-machines-execute', (event, command) => remoteMachineIpc.execute(event, command))
    ipcMain.handle('desktop:coworker-share-pick', event => sharesFor(trusted(event).window).pickImport())
    ipcMain.handle('desktop:template-pick', event => templatesFor(trusted(event).window).pickImport())
    ipcMain.handle('desktop:template-save', (event, value) => templatesFor(trusted(event).window).saveArtifact(value))
    ipcMain.handle('desktop:result-save', (event, value) => filesFor(trusted(event).window).saveResultFile(value))
    ipcMain.handle('desktop:coworker-file-save', (event, value) => filesFor(trusted(event).window).saveCoworkerFile(value))
    ipcMain.handle('desktop:shared-file-save', (event, value) => filesFor(trusted(event).window).saveSharedFile(value))
    ipcMain.handle('desktop:notify', (event, value) => {
        trusted(event)
        const scope = clickScope()
        if (!scope || !isDesktopPage(event.senderFrame.url)) return { status: 'unavailable' }
        return desktopNotifications.notify(value, scope)
    })
    ipcMain.on('desktop:inbox-badge', (event, value) => {
        try {
            trustedPrimary(event)
            const scope = runtimeScope()
            if (!scope || !isDesktopPage(event.senderFrame.url) || value?.workspaceId !== scope.workspaceId
                || value.launchNonce !== scope.launchNonce || !Number.isSafeInteger(value.count) || value.count < 0) return
            setMacUnread(Math.min(value.count, 9999))
        } catch { /* A stale or untrusted renderer cannot update native badges. */ }
    })
    ipcMain.handle('desktop:save-draining-draft', (event, value) => {
        const board = trusted(event)
        const signal = board.drafts.signalFor(value)
        if (!signal || !runtime || runtime !== supervisor?.runtime || !isDesktopPage(event.senderFrame.url)) {
            throw new Error('The pending draft save is no longer active')
        }
        return supervisor.saveDrainingDraft(value.agentId, value.body, signal)
    })
    for (const [channel, handle] of [
        ['desktop:drafts-ready', (drafts, value) => drafts.register(value?.registrationId)],
        ['desktop:drafts-unready', (drafts, value) => drafts.unregister(value?.registrationId)],
        ['desktop:drafts-flushed', (drafts, value) => drafts.acknowledge(value)],
    ]) ipcMain.on(channel, (event, value) => {
        // Event handlers must ignore untrusted frames rather than throw in the main process.
        try {
            const board = trusted(event)
            if (boards.ready(board, runtime)) handle(board.drafts, value)
        } catch {}
    })
    const clickRegistration = value => {
        const registrationId = value?.registrationId
        return typeof registrationId === 'string' && registrationId && registrationId.length <= 128 ? registrationId : null
    }
    ipcMain.on('desktop:notification-clicks-ready', (event, value) => {
        try {
            trustedPrimary(event)
            const registrationId = clickRegistration(value)
            if (!registrationId || !isDesktopPage(event.senderFrame.url)) return
            clickReady = { contents: event.sender, registrationId }
            flushNotificationClicks()
        } catch {}
    })
    ipcMain.on('desktop:notification-clicks-unready', (event, value) => {
        try {
            trustedPrimary(event)
            const registrationId = clickRegistration(value)
            if (registrationId && clickReady?.registrationId === registrationId && clickReady.contents === event.sender) clickReady = null
        } catch {}
    })
    const existingLocal = !mac || await hasLocalWorkspace(dataRoot)
    const restoreConnected = startupWorkspace?.selection() === 'connected'
    if (mac) {
        const t = shellText(shellLanguage.forScope('local'))
        bootStatus = existingLocal && !restoreConnected
            ? { state: 'starting', message: t('startup.keychainPrompt') } : workspaceChoiceStatus()
    }
    await window.loadFile(startup)
    if (openRememberedHub && (restoreConnected || !existingLocal)) await reopenRememberedHub()
    if (existingLocal && !restoreConnected) await startLocalWorkspace()
}

async function openLocalWorkspace() {
    reopeningHub?.controller.abort()
    const opened = await startLocalWorkspace()
    if (opened && runtimeScope()) await startupWorkspace?.remember('local')
    return opened
}

async function startLocalWorkspace() {
    if (quitting || openingLocalWorkspace || supervisor) return false
    const attempt = new AbortController()
    openingLocalWorkspace = attempt
    try {
        if (mac) publishBootStatus({ state: 'keychain', message: shellText(shellLanguage.forScope('local'))('startup.keychainPrompt'),
            choices: startupChoices(false) })
        const identity = await loadIdentityFromSafeStorage(dataRoot, safeStorage, { signal: attempt.signal })
        if (attempt.signal.aborted || quitting) return false
        publishBootStatus({ state: 'starting', message: 'Preparing local runtime…' })
        await initializeLocalWorkspace(identity)
        return true
    } catch (error) {
        if (!attempt.signal.aborted && !quitting) reportStartupError(error)
        return false
    } finally {
        if (openingLocalWorkspace === attempt) openingLocalWorkspace = null
    }
}

async function initializeLocalWorkspace(identity) {
    const bundle = await loadBundle(resources)
    if (quitting) return
    if (process.platform === 'darwin') app.setAboutPanelOptions({ version: bundle.buildId })
    supervisor = new RuntimeSupervisor({ bundle, root: dataRoot, identity, appStoreBuild: process.mas === true })
    remoteInstallId = identity.installId
    remoteMachines = createNativeRemoteMachines({ dataRoot, installId: identity.installId, safeStorage,
        workspaceKey: workspaceId => workspaceIdentity(identity, workspaceId).encryptionKey,
        supervisor,
        draftQuit: {
            get ready() { return boards.get(window)?.drafts.ready === true },
            request: () => boards.flushAll(runtime, true),
        },
        currentRenderer: () => {
            const current = supervisor.runtime
            if (quitting || transitioning || !runtime || current !== runtime || supervisor.status.state !== 'ready'
                || !boards.ready(boards.get(window), current)) return null
            return { epoch: boards.get(window).epoch, workspaceId: current.workspaceId, launchNonce: current.launchNonce }
        },
        // The canonical local workspace supervisor is connected here. Remote activation
        // needs an owned loopback gateway and durable lifecycle receipts; neither is
        // replaced by a health response. Missing transitions fail before any effect.
    })
    supervisor.on('status', status => {
        for (const board of boards.list()) board.contents.send('desktop:status', status)
        if (status.state === 'error') {
            retireAdditionalBoards()
            runtime = null
            if (window && !window.isDestroyed()) void window.loadFile(startup)
        }
    })
    await seedLegacyCatalog(dataRoot, identity.installId)
    if (quitting) return
    workspaces = createWorkspaceCoordinator({ dataRoot, installId: identity.installId, ports: {
        isQuitInProgress: () => quitting,
        freezeAdmissions: context => supervisor.admissions('freeze', context.requestId),
        unfreezeAdmissions: async context => {
            await supervisor.admissions('unfreeze', context.requestId)
            if (runtime === supervisor.runtime) resumeAfterCancelledQuit()
        },
        flushDrafts: async () => ({ saved: await boards.flushAll(runtime, true) }),
        prepareRecovery: () => supervisor.prepareWorkspaceRecovery(),
        stopAndDrain: async () => { await closeRemoteWorkspace(supervisor.runtime?.workspaceId); await supervisor.stop() },
        bindAndStart: async workspaceId => {
            const { workspace } = await getWorkspace(dataRoot, identity.installId, workspaceId)
            if (!workspace) throw new Error('Workspace no longer exists')
            return supervisor.startFor(workspaceId, { ...workspace, frozen: true })
        },
        verifyRuntimeIdentity: async workspaceId => supervisor.status.state === 'ready' && supervisor.runtime?.workspaceId === workspaceId,
    } })
    if (mac) {
        phonePairing = createMacPhonePairingService({
            dataRoot,
            installId: identity.installId,
            getRuntime: () => !quitting && !transitioning && runtimeScope() ? runtime : null,
        })
        // An unavailable optional listener cannot prevent the local board from opening.
        void phonePairing.restore().catch(() => console.warn('Could not restore local phone pairing.'))
    }
    await startWorkspace()
}

function closeRemoteWorkspace(workspaceId) {
    if (!remoteMachines || !workspaceId) return Promise.resolve()
    if (remoteClosures.has(workspaceId)) return remoteClosures.get(workspaceId)
    const work = remoteMachines.closeWorkspace(workspaceId)
    remoteClosures.set(workspaceId, work)
    // Always observe the cleanup task; awaited switch/quit paths still receive failure.
    void work.finally(() => { if (remoteClosures.get(workspaceId) === work) remoteClosures.delete(workspaceId) }).catch(() => {})
    return work
}

async function prepareWorkspaceWindow(workspaceId, load = true) {
    const partition = workspaceId === 1 ? profile : `persist:rerun-desktop-workspace-${workspaceId}`
    const desktopSession = session.fromPartition(partition)
    const microphone = desktopMicrophonePermissions({
        context: contents => {
            if (!contents || contents.isDestroyed()) return null
            const candidate = BrowserWindow.fromWebContents(contents)
            return boardContext(candidate) && contents.session === desktopSession && candidate.isVisible() ? candidate : null
        },
        isDesktopPage,
    })
    desktopSession.setPermissionRequestHandler(microphone.request)
    desktopSession.setPermissionCheckHandler(microphone.check)
    const old = window
    const placement = mac
        ? (old && captureWindowPlacement(old)) || await windowPlacements.restore(boardPlacement)
        : { bounds: old && !old.isDestroyed() ? old.getBounds() : null }
    if (old && !old.isDestroyed()) old.destroy()
    desktopNotifications.close()
    desktopNotifications = createNotices()
    window = createBoardWindow(desktopSession, placement.bounds, true).window
    if (windowPlacements) {
        restoreWindowZoom(window, placement.maximized)
        saveBoardPlacement = windowPlacements.track(boardPlacement, window)
    }
    activeSession = desktopSession
    activeWorkspaceId = workspaceId
    if (load) await window.loadFile(startup)
}

function createBoardWindow(desktopSession, bounds, primary = false) {
    const boardWindow = new BrowserWindow({
        ...(bounds || { width: 1220, height: 820 }), minWidth: 720, minHeight: 520, show: false,
        title: 'Rerun Desktop Preview', backgroundColor: '#101214',
        ...(mac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 8 } } : {}),
        webPreferences: { preload: resolve(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, session: desktopSession },
    })
    const board = boards.register(boardWindow, { primary })
    boardWindow.once('ready-to-show', () => {
        if (primary ? showWindowOnReady && window === boardWindow : boards.ready(board, runtime)) boardWindow.show()
    })
    boardWindow.on('close', event => {
        if (quittingNow) return
        if (quitting || transitioning || changingBoards.has(boardWindow)) { event.preventDefault(); return }
        if (!mac) return
        event.preventDefault()
        if (primary) hideWorkspaceWindow(boardWindow)
        else void closeAdditionalBoard(board)
    })
    const { contents } = board
    if (mac) {
        // The authenticated board draws its strip on first paint. This marker only affects layout.
        contents.setUserAgent(contents.getUserAgent() + ' RerunLocalDesktopMac/1')
        const reportFullscreen = () => {
            if (contents.isDestroyed()) return
            const frame = contents.mainFrame
            if (((primary || board.rendererFailure === runtime && runtime) && frame?.url === pathToFileURL(startup).href)
                || boards.ready(board, runtime)) {
                frame.send('desktop:mac-fullscreen-changed', boardWindow.isFullScreen())
            }
        }
        boardWindow.on('enter-full-screen', reportFullscreen)
        boardWindow.on('leave-full-screen', reportFullscreen)
    }
    if (mac) attachDesktopContextMenu({
        window: boardWindow, Menu, clipboard, openExternal, locale: () => shellLanguage.forScope('local'),
        currentScope: () => boardContext(boardWindow)?.rendererEpoch ?? null,
        saveImage: (pageURL, srcURL) => filesFor(boardWindow).saveDisplayedImage(pageURL, srcURL),
        reportFailure: error => reportImageSaveFailure(boardWindow, error),
    })
    const invalidateRenderer = () => {
        windowFind.close(boardWindow)
        if (!contents.isDestroyed()) boards.invalidate(board)
        if (!primary || window !== boardWindow) return
        quickAsk.invalidate()
        setMacUnread(0)
        clickReady = null
        // Revoke the lease immediately, then drain only this workspace's remote work.
        // A failed drain cannot turn an old receipt into a successful connection.
        void closeRemoteWorkspace(activeWorkspaceId).catch(() => {})
    }
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) invalidateRenderer()
    })
    contents.on('render-process-gone', (_event, details) => {
        invalidateRenderer()
        const current = board.runtime
        if (!mac || details.reason === 'clean-exit' || !canRecoverBoard(board, current)) return
        const at = performance.now()
        const repeated = board.rendererCrash?.runtime === current && at - board.rendererCrash.at < rendererCrashInterval
        const crash = { runtime: current, at }
        board.rendererCrash = crash
        if (repeated && contents.getURL() === pathToFileURL(startup).href) return
        if (repeated || board.rendererFailure === current) void showBoardRendererFailure(board, crash)
        else void reopenBoardRenderer(board, crash)
    })
    contents.on('destroyed', invalidateRenderer)
    contents.on('will-attach-webview', event => event.preventDefault())
    for (const eventName of ['will-navigate', 'will-redirect']) {
        contents.on(eventName, (event, target) => {
            if (!runtime || board.runtime !== runtime || !isDesktopPage(target)) event.preventDefault()
        })
    }
    contents.setWindowOpenHandler(({ url }) => {
        openExternal(url)
        return { action: 'deny' }
    })
    return board
}

function canRecoverBoard(board, current) {
    return !!current && !quitting && !transitioning && runtime === current && board.runtime === current
        && runtimeScope() && boards.get(board.window) === board
}

async function showBoardRendererFailure(board, crash) {
    if (board.rendererCrash !== crash || !canRecoverBoard(board, crash.runtime)) return
    board.rendererFailure = crash.runtime
    await board.window.loadFile(startup).catch(() => {})
}

async function reopenBoardRenderer(board, crash) {
    if (board.rendererCrash !== crash || !canRecoverBoard(board, crash.runtime)) return false
    try {
        await loadBoard(board, crash.runtime)
        if (board.rendererCrash !== crash || !canRecoverBoard(board, crash.runtime)) return false
        board.rendererFailure = null
        return true
    } catch {
        await showBoardRendererFailure(board, crash)
        return false
    }
}

async function reloadBoard(candidate) {
    const context = boardContext(candidate)
    if (!context) return
    const board = boards.get(candidate)
    changingBoards.add(candidate)
    try {
        await boards.reload(board, context.runtime, () => confirmDiscard(candidate, 'Reload'), () => resumeBoard(board))
    } finally { changingBoards.delete(candidate) }
}

async function closeAdditionalBoard(board) {
    const candidate = board.window
    if (changingBoards.has(candidate)) return
    changingBoards.add(candidate)
    try {
        windowFind.close(candidate)
        await completeDesktopQuit({
            flush: () => boards.flush(board, runtime),
            confirmDiscard: () => confirmDiscard(candidate, 'Close'),
            stop: async () => {},
            quit: () => { if (!candidate.isDestroyed()) candidate.destroy() },
            cancelled: () => resumeBoard(board),
        })
    } finally { changingBoards.delete(candidate) }
}

async function loadBoard(board, current) {
    board.runtime = current
    await board.window.loadURL(`${current.app.origin}/desktop`)
}

function retireAdditionalBoards() {
    return boards.list().filter(board => !board.primary).map(board => {
        const bounds = board.window.getBounds()
        board.window.destroy()
        return bounds
    })
}

async function openAdditionalBoard(bounds) {
    if (!bounds) {
        const from = focusedBoard()
        if (!boardContext(from)) return
        bounds = cascadeWindowBounds(from, screen)
    }
    const current = runtime
    if (!mac || !runtimeScope() || !activeSession) return
    const board = createBoardWindow(activeSession, bounds)
    try {
        await loadBoard(board, current)
        if (boards.ready(board, runtime) && !board.window.isVisible()) board.window.show()
    }
    catch { if (!board.window.isDestroyed()) board.window.destroy() }
}

async function displayWorkspace() {
    const current = supervisor.runtime
    if (!current || supervisor.status.state !== 'ready') throw new Error('Workspace is not ready')
    const extraBounds = retireAdditionalBoards()
    runtime = current
    if (activeWorkspaceId !== current.workspaceId) await prepareWorkspaceWindow(current.workspaceId)
    await activeSession.cookies.set({ url: current.app.origin, name: 'rerun-desktop-session', value: current.app.sessionToken, httpOnly: true, sameSite: 'strict', path: '/' })
    await loadBoard(boards.get(window), current)
    await Promise.all(extraBounds.map(bounds => openAdditionalBoard(bounds)))
    clickHandoff.retain(runtimeScope())
}
async function startWorkspace() {
    try {
        const selected = await workspaces.coldLaunchTarget()
        if (!selected.ok) {
            supervisor.publish('error', 'A workspace switch needs recovery. Choose Retry to recover the same workspace.')
            return
        }
        await supervisor.startFor(selected.workspaceId, selected.workspace)
        await displayWorkspace()
    } catch {
        supervisor.publish('error', 'This workspace could not open safely. Choose Retry to try again.')
    }
}
async function runWorkspaceTransition(operation) {
    if (transitioning || changingBoards.size) return { ok: false, code: 'busy', message: 'A window or workspace change is already in progress.' }
    transitioning = true
    quickAsk.reset()
    const previous = supervisor.runtime
    try {
        const result = await operation()
        if (result.ok) {
            if (supervisor.runtime !== previous || runtime !== previous) await displayWorkspace()
        }
        else if (supervisor.runtime !== previous || (await workspaces.reconcile()).requiresManualRecovery) {
            runtime = null
            await window.loadFile(startup)
            supervisor.publish('error', 'A workspace switch needs recovery. Choose Retry to recover the same workspace.')
        }
        return result
    } catch {
        runtime = null
        await window.loadFile(startup)
        supervisor.publish('error', 'Workspace state needs recovery. Choose Retry to try again.')
        return { ok: false, code: 'path_corrupt', message: 'Workspace state needs recovery before continuing.' }
    } finally { transitioning = false; flushNotificationClicks() }
}
