import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, session, Tray, WebContentsView } from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createWorkspaceCoordinator, seedLegacyCatalog, getWorkspace } from './workspaces/index.mjs'
import { loadBundle, loadIdentity, workspaceIdentity } from './runtime.mjs'
import { RuntimeSupervisor } from './supervisor.mjs'
import { createDesktopNotifications } from './notifications.mjs'
import { createNotificationClickHandoff } from './notification-click-handoff.mjs'
import { BeforeQuitDrafts, completeDesktopQuit } from './before-quit.mjs'
import { createDesktopTemplateFiles } from './templates.mjs'
import { createDesktopCoworkerShareFiles } from './coworker-share-files.mjs'
import { createNativeRemoteMachines } from './remote-machines/binding.mjs'
import { createRemoteMachineIpc } from './remote-machines/ipc.mjs'
import { desktopMicrophonePermissions } from './media-permissions.mjs'
import { createDesktopFileSaves } from './result-files.mjs'
import { installMacApplicationMenu } from './application-menu.mjs'
import { createMacMenuBar } from './mac-menu-bar.mjs'
import { attachDesktopContextMenu, externalDesktopLink } from './window-context-menu.mjs'
import { createWindowFind } from './window-find.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const startup = resolve(directory, 'startup.html')
const mac = process.platform === 'darwin'
let window
let menuBar
let showWindowOnReady = true
let supervisor
let runtime
let workspaces
let remoteMachines
let remoteInstallId
let rendererEpoch = randomUUID()
const remoteClosures = new Map()
let activeSession
let activeWorkspaceId
let transitioning = false
let quitting = false
let quittingNow = false
let bootStatus = { state: 'starting', message: 'Preparing local runtime…' }
const profile = 'persist:rerun-desktop-local'
const draftQuit = new BeforeQuitDrafts()
const windowFind = createWindowFind({ WebContentsView, scopeOf: candidate => !quitting && !transitioning
    && candidate && candidate === window && !candidate.isDestroyed() && runtimeScope()
    && isDesktopPage(candidate.webContents.mainFrame?.url) ? rendererEpoch : null,
    topInset: candidate => mac && !candidate.isFullScreen() ? 28 : 0,
})
const { saveResultFile, saveCoworkerFile, saveSharedFile } = createDesktopFileSaves({ dialog, context: () => {
    if (quitting || transitioning || !window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) return null
    return { runtime, window }
} })
const templateFiles = createDesktopTemplateFiles({ dialog, context: () => {
    if (quitting || transitioning || !window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) return null
    return { runtime, window }
} })
const coworkerShareFiles = createDesktopCoworkerShareFiles({ dialog, context: () => {
    if (quitting || transitioning || !window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) return null
    return { runtime, window }
} })
const remoteMachineIpc = createRemoteMachineIpc({ trusted, context: () => {
    const current = supervisor?.runtime
    if (quitting || transitioning || !remoteMachines || !runtime || runtime !== current || supervisor.status.state !== 'ready'
        || remoteClosures.has(current.workspaceId) || !window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) return null
    return { binding: remoteMachines, actor: { installId: remoteInstallId, workspaceId: current.workspaceId,
        launchNonce: current.launchNonce, rendererEpoch } }
} })
const clickHandoff = createNotificationClickHandoff()
let clickReady = null
let desktopNotifications = createNotices()
function showMainWindow() {
    showWindowOnReady = true
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
}
function setMacUnread(count) {
    if (process.platform !== 'darwin') return
    app.setBadgeCount(count)
    try { menuBar?.setUnread(count) }
    catch { console.warn('Could not update the Rerun menu-bar item.') }
}
function openExternal(href) {
    const url = externalDesktopLink(href)
    if (url) void shell.openExternal(url).catch(() => {})
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
        if (quitting || transitioning || !window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) return false
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

if (!app.requestSingleInstanceLock()) app.quit()
else {
    app.on('second-instance', showMainWindow)
    app.on('activate', showMainWindow)
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
    app.on('before-quit', event => {
        if (quittingNow) return
        event.preventDefault()
        if (quitting || transitioning) return
        quitting = true
        windowFind.close(window)
        void completeDesktopQuit({
            flush: () => {
                if (!window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url) || !draftQuit.ready) return true
                return draftQuit.request(value => window.webContents.send('desktop:before-quit', value))
            },
            confirmDiscard: async () => {
                const options = {
                    type: 'warning', title: 'Unsaved changes',
                    message: 'Some changes haven’t been saved.',
                    detail: 'Stay in Rerun to review or save your changes, or quit without saving them.',
                    buttons: ['Stay', 'Quit without saving'], defaultId: 0, cancelId: 0, noLink: true,
                }
                const parent = window && !window.isDestroyed() ? window : null
                if (parent) { parent.show(); parent.focus() }
                const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
                return result.response === 1
            },
            stop: async () => { await remoteMachines?.close(); await supervisor?.stop() },
            quit: () => { clickHandoff.stop(); quittingNow = true; app.quit() },
            cancelled: resumeAfterCancelledQuit,
        }).catch(() => { if (!quittingNow) resumeAfterCancelledQuit() })
    })
    app.whenReady().then(launch).catch(() => {
        bootStatus = { state: 'error', message: 'Desktop setup failed. Check that this app has a complete bundled runtime and access to Mac secure storage.' }
        if (supervisor) supervisor.publish('error', 'Workspace state could not be verified. Restore the workspace state before retrying.')
        else window?.webContents.send('desktop:status', bootStatus)
    })
}

function trusted(event) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted desktop request')
    const url = new URL(event.senderFrame.url)
    if (url.href !== pathToFileURL(startup).href && (!runtime || url.origin !== runtime.app.origin || url.pathname !== '/desktop')) throw new Error('Untrusted desktop page')
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
    try {
        if (window && !window.isDestroyed() && isDesktopPage(window.webContents.mainFrame.url)) {
            window.webContents.send('desktop:quit-cancelled')
        }
    } catch {}
    flushNotificationClicks()
}

async function launch() {
    if (process.platform === 'darwin') {
        installMacApplicationMenu({
            Menu, appName: app.name, isDesktopPage,
            settingsWindow: () => !quitting && !transitioning && runtimeScope() && draftQuit.ready ? window : null,
            openDocumentation: () => openExternal('https://docs.rerun.build'),
            openFind: () => windowFind.open(window),
        })
        try {
            menuBar = createMacMenuBar({ app, Menu, Tray, nativeImage, openWindow: showMainWindow })
            showWindowOnReady = !menuBar.startedAtLogin
        } catch {
            console.warn('Could not start the Rerun menu-bar item.')
        }
    }
    const dataRoot = resolve(app.getPath('appData'), 'Rerun Desktop Preview')
    await mkdir(dataRoot, { recursive: true, mode: 0o700 })
    app.setPath('userData', dataRoot)
    await prepareWorkspaceWindow(1, false)
    ipcMain.handle('desktop:status', event => { trusted(event); return supervisor?.status ?? bootStatus })
    if (mac) {
        ipcMain.on('desktop:find-open', event => {
            try { trusted(event); windowFind.open(window) } catch { /* Ignore untrusted frames. */ }
        })
        ipcMain.on('desktop:find-query', (event, input) => windowFind.search(event, input))
        ipcMain.on('desktop:find-close', event => windowFind.dismiss(event))
        ipcMain.handle('desktop:mac-fullscreen', event => { trusted(event); return window.isFullScreen() })
    }
    ipcMain.handle('desktop:retry', async event => {
        trusted(event)
        if (transitioning || quitting) return false
        if (!supervisor) { app.relaunch(); app.quit(); return true }
        if (!workspaces) return false
        if (['starting', 'stopping'].includes(supervisor.status.state)) return false
        const pending = (await workspaces.reconcile()).openReceipt
        if (pending) return runWorkspaceTransition(() => workspaces.recoverSwitch({ requestId: pending.requestId, workspaceId: pending.toWorkspaceId }))
        await closeRemoteWorkspace(supervisor.runtime?.workspaceId)
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
    ipcMain.handle('desktop:quit', event => { trusted(event); app.quit() })
    ipcMain.handle('desktop:remote-machines-actor', event => remoteMachineIpc.actor(event))
    ipcMain.handle('desktop:remote-machines-execute', (event, command) => remoteMachineIpc.execute(event, command))
    ipcMain.handle('desktop:coworker-share-pick', event => { trusted(event); return coworkerShareFiles.pickImport() })
    ipcMain.handle('desktop:template-pick', event => { trusted(event); return templateFiles.pickImport() })
    ipcMain.handle('desktop:template-save', (event, value) => { trusted(event); return templateFiles.saveArtifact(value) })
    ipcMain.handle('desktop:result-save', (event, value) => { trusted(event); return saveResultFile(value) })
    ipcMain.handle('desktop:coworker-file-save', (event, value) => { trusted(event); return saveCoworkerFile(value) })
    ipcMain.handle('desktop:shared-file-save', (event, value) => { trusted(event); return saveSharedFile(value) })
    ipcMain.handle('desktop:notify', (event, value) => {
        trusted(event)
        const scope = clickScope()
        if (!scope || !isDesktopPage(event.senderFrame.url)) return { status: 'unavailable' }
        return desktopNotifications.notify(value, scope)
    })
    ipcMain.on('desktop:inbox-badge', (event, value) => {
        try {
            trusted(event)
            const scope = runtimeScope()
            if (!scope || !isDesktopPage(event.senderFrame.url) || value?.workspaceId !== scope.workspaceId
                || value.launchNonce !== scope.launchNonce || !Number.isSafeInteger(value.count) || value.count < 0) return
            setMacUnread(Math.min(value.count, 9999))
        } catch { /* A stale or untrusted renderer cannot update native badges. */ }
    })
    ipcMain.handle('desktop:save-draining-draft', (event, value) => {
        trusted(event)
        const signal = draftQuit.signalFor(value)
        if (!signal || !runtime || runtime !== supervisor?.runtime || !isDesktopPage(event.senderFrame.url)) {
            throw new Error('The pending draft save is no longer active')
        }
        return supervisor.saveDrainingDraft(value.agentId, value.body, signal)
    })
    for (const [channel, handle] of [
        ['desktop:drafts-ready', value => draftQuit.register(value?.registrationId)],
        ['desktop:drafts-unready', value => draftQuit.unregister(value?.registrationId)],
        ['desktop:drafts-flushed', value => draftQuit.acknowledge(value)],
    ]) ipcMain.on(channel, (event, value) => {
        // Event handlers must ignore untrusted frames rather than throw in the main process.
        try { trusted(event); if (isDesktopPage(event.senderFrame.url)) handle(value) } catch {}
    })
    const clickRegistration = value => {
        const registrationId = value?.registrationId
        return typeof registrationId === 'string' && registrationId && registrationId.length <= 128 ? registrationId : null
    }
    ipcMain.on('desktop:notification-clicks-ready', (event, value) => {
        try {
            trusted(event)
            const registrationId = clickRegistration(value)
            if (!registrationId || !isDesktopPage(event.senderFrame.url)) return
            clickReady = { contents: event.sender, registrationId }
            flushNotificationClicks()
        } catch {}
    })
    ipcMain.on('desktop:notification-clicks-unready', (event, value) => {
        try {
            trusted(event)
            const registrationId = clickRegistration(value)
            if (registrationId && clickReady?.registrationId === registrationId && clickReady.contents === event.sender) clickReady = null
        } catch {}
    })
    await window.loadFile(startup)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Mac secure storage is unavailable')
    const identity = await loadIdentity(dataRoot, { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) })
    const resources = app.isPackaged ? process.resourcesPath : resolve(directory, '../../resources')
    const bundle = await loadBundle(resources)
    if (process.platform === 'darwin') app.setAboutPanelOptions({ version: bundle.buildId })
    supervisor = new RuntimeSupervisor({ bundle, root: dataRoot, identity })
    remoteInstallId = identity.installId
    remoteMachines = createNativeRemoteMachines({ dataRoot, installId: identity.installId, safeStorage,
        workspaceKey: workspaceId => workspaceIdentity(identity, workspaceId).encryptionKey,
        supervisor, draftQuit,
        currentRenderer: () => {
            const current = supervisor.runtime
            if (quitting || transitioning || !runtime || current !== runtime || supervisor.status.state !== 'ready'
                || !window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) return null
            return { epoch: rendererEpoch, workspaceId: current.workspaceId, launchNonce: current.launchNonce }
        },
        sendDraftFlush: value => {
            if (!window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) throw new Error('The workspace window is unavailable')
            window.webContents.send('desktop:before-quit', value)
        },
        // The canonical local workspace supervisor is connected here. Remote activation
        // needs an owned loopback gateway and durable lifecycle receipts; neither is
        // replaced by a health response. Missing transitions fail before any effect.
    })
    supervisor.on('status', status => {
        if (!window?.isDestroyed()) window.webContents.send('desktop:status', status)
        if (status.state === 'error') { runtime = null; void window.loadFile(startup) }
    })
    await seedLegacyCatalog(dataRoot, identity.installId)
    workspaces = createWorkspaceCoordinator({ dataRoot, installId: identity.installId, ports: {
        isQuitInProgress: () => quitting,
        freezeAdmissions: context => supervisor.admissions('freeze', context.requestId),
        unfreezeAdmissions: async context => {
            await supervisor.admissions('unfreeze', context.requestId)
            if (runtime === supervisor.runtime) resumeAfterCancelledQuit()
        },
        flushDrafts: async () => {
            if (!runtime || !window || window.isDestroyed() || !isDesktopPage(window.webContents.mainFrame.url)) return { saved: true }
            if (!draftQuit.ready) return { saved: false }
            return { saved: await draftQuit.request(value => window.webContents.send('desktop:before-quit', value)) }
        },
        prepareRecovery: () => supervisor.prepareWorkspaceRecovery(),
        stopAndDrain: async () => { await closeRemoteWorkspace(supervisor.runtime?.workspaceId); await supervisor.stop() },
        bindAndStart: async workspaceId => {
            const { workspace } = await getWorkspace(dataRoot, identity.installId, workspaceId)
            if (!workspace) throw new Error('Workspace no longer exists')
            return supervisor.startFor(workspaceId, { ...workspace, frozen: true })
        },
        verifyRuntimeIdentity: async workspaceId => supervisor.status.state === 'ready' && supervisor.runtime?.workspaceId === workspaceId,
    } })
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
        context: () => !quitting && !transitioning && window && !window.isDestroyed() && window.isVisible() ? window : null,
        isDesktopPage,
    })
    desktopSession.setPermissionRequestHandler(microphone.request)
    desktopSession.setPermissionCheckHandler(microphone.check)
    const old = window
    const bounds = old && !old.isDestroyed() ? old.getBounds() : null
    if (old && !old.isDestroyed()) old.destroy()
    desktopNotifications.close()
    desktopNotifications = createNotices()
    window = new BrowserWindow({
        ...(bounds || { width: 1220, height: 820 }), minWidth: 720, minHeight: 520, show: false,
        title: 'Rerun Desktop Preview', backgroundColor: '#101214',
        ...(mac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 8 } } : {}),
        webPreferences: { preload: resolve(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition },
    })
    const boardWindow = window
    boardWindow.once('ready-to-show', () => { if (showWindowOnReady && window === boardWindow) boardWindow.show() })
    window.on('close', event => {
        if (quitting && !quittingNow) { event.preventDefault(); return }
        if (!quittingNow && process.platform === 'darwin') { event.preventDefault(); window.hide() }
    })
    const contents = window.webContents
    if (mac) {
        // The authenticated board draws its strip on first paint. This marker only affects layout.
        contents.setUserAgent(contents.getUserAgent() + ' RerunLocalDesktopMac/1')
        const reportFullscreen = () => {
            if (window !== boardWindow || contents.isDestroyed()) return
            const frame = contents.mainFrame
            if (frame?.url === pathToFileURL(startup).href || isDesktopPage(frame?.url)) {
                frame.send('desktop:mac-fullscreen-changed', boardWindow.isFullScreen())
            }
        }
        boardWindow.on('enter-full-screen', reportFullscreen)
        boardWindow.on('leave-full-screen', reportFullscreen)
    }
    if (process.platform === 'darwin') attachDesktopContextMenu({
        window: boardWindow, Menu, clipboard, openExternal, locale: app.getLocale(),
        currentScope: () => !quitting && !transitioning && window === boardWindow && !boardWindow.isDestroyed()
            && runtimeScope() && isDesktopPage(contents.mainFrame?.url) ? rendererEpoch : null,
    })
    rendererEpoch = randomUUID()
    const invalidateRenderer = () => {
        windowFind.close(boardWindow)
        if (window?.webContents !== contents) return
        setMacUnread(0)
        rendererEpoch = randomUUID()
        clickReady = null
        draftQuit.reset()
        // Revoke the lease immediately, then drain only this workspace's remote work.
        // A failed drain cannot turn an old receipt into a successful connection.
        void closeRemoteWorkspace(activeWorkspaceId).catch(() => {})
    }
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) invalidateRenderer()
    })
    contents.on('render-process-gone', invalidateRenderer)
    contents.on('destroyed', invalidateRenderer)
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-navigate', (event, target) => {
        let url
        try { url = new URL(target) } catch { event.preventDefault(); return }
        if (!runtime || url.origin !== runtime.app.origin || url.pathname !== '/desktop') event.preventDefault()
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url)
        return { action: 'deny' }
    })
    activeSession = desktopSession
    activeWorkspaceId = workspaceId
    if (load) await window.loadFile(startup)
}

async function displayWorkspace() {
    const current = supervisor.runtime
    if (!current || supervisor.status.state !== 'ready') throw new Error('Workspace is not ready')
    runtime = current
    if (activeWorkspaceId !== current.workspaceId) await prepareWorkspaceWindow(current.workspaceId)
    await activeSession.cookies.set({ url: current.app.origin, name: 'rerun-desktop-session', value: current.app.sessionToken, httpOnly: true, sameSite: 'strict', path: '/' })
    await window.loadURL(`${current.app.origin}/desktop`)
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
    if (transitioning) return { ok: false, code: 'busy', message: 'A workspace change is already in progress.' }
    transitioning = true
    const previous = supervisor.runtime
    try {
        const result = await operation()
        if (result.ok) await displayWorkspace()
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
