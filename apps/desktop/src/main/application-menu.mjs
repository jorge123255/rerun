import { QUICK_ASK_SHORTCUT } from './quick-ask-window.mjs'
import { shellText } from './shell-language.mjs'

export function installMacApplicationMenu({ Menu, appName, settingsWindow, isDesktopPage, openDocumentation, openFind, openQuickAsk, openNewWindow, openLocalWorkspace, openHubPicker, reloadWindow, devTools, locale, checkForUpdates, updateItem }) {
    const t = shellText(locale)
    const name = { name: appName }
    const template = [
        { label: appName, submenu: [
            { role: 'about', label: t('menu.app.about', name) },
            { type: 'separator' },
            ...(checkForUpdates ? [{
                id: 'rerun-check-for-updates', label: updateItem.label, enabled: updateItem.enabled,
                click: () => { if (updateItem.enabled) checkForUpdates() },
            }] : []),
            {
                id: 'rerun-settings',
                label: t('menu.app.settings'),
                accelerator: 'Command+,',
                click: () => {
                    const window = settingsWindow()
                    if (!window || window.isDestroyed()) return
                    const frame = window.webContents.mainFrame
                    if (!frame || !isDesktopPage(frame.url)) return
                    if (window.isMinimized()) window.restore()
                    window.show()
                    window.focus()
                    frame.send('desktop:open-settings')
                },
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide', label: t('menu.app.hide', name) }, { role: 'hideOthers', label: t('menu.app.hideOthers') }, { role: 'unhide', label: t('menu.app.showAll') },
            { type: 'separator' },
            { role: 'quit', label: t('menu.app.quit', name) },
        ] },
        { role: 'fileMenu', label: t('menu.file.title'), submenu: [
            { id: 'rerun-new-window', label: t('menu.file.newWindow'), accelerator: 'CmdOrCtrl+Shift+N', click: openNewWindow },
            ...(openLocalWorkspace ? [{ id: 'rerun-open-local', label: t('menu.file.openLocal'), click: openLocalWorkspace }] : []),
            { id: 'rerun-connect-hub', label: t('menu.file.connect'), click: openHubPicker },
            { id: 'rerun-quick-ask', label: t('tray.quickAsk'), accelerator: QUICK_ASK_SHORTCUT, registerAccelerator: false, click: openQuickAsk },
            { type: 'separator' }, { role: 'close', label: t('menu.file.closeWindow') },
        ] },
        { role: 'editMenu', label: t('menu.edit.title'), submenu: [
            { role: 'undo', label: t('menu.edit.undo') }, { role: 'redo', label: t('menu.edit.redo') }, { type: 'separator' },
            { role: 'cut', label: t('menu.edit.cut') }, { role: 'copy', label: t('menu.edit.copy') }, { role: 'paste', label: t('menu.edit.paste') }, { role: 'pasteAndMatchStyle', label: t('menu.edit.pasteAndMatchStyle') },
            { role: 'delete', label: t('menu.edit.delete') }, { role: 'selectAll', label: t('menu.edit.selectAll') }, { type: 'separator' },
            { id: 'rerun-find', label: t('menu.edit.find'), click: openFind },
        ] },
        { label: t('menu.view.title'), submenu: [
            { id: 'rerun-reload', label: t('menu.view.reload'), accelerator: 'CmdOrCtrl+R', click: reloadWindow },
            ...(devTools ? [{ role: 'toggleDevTools', label: t('menu.view.toggleDevTools') }] : []),
            { type: 'separator' }, { role: 'resetZoom', label: t('menu.view.actualSize') }, { role: 'zoomIn', label: t('menu.view.zoomIn') }, { role: 'zoomOut', label: t('menu.view.zoomOut') },
            { type: 'separator' }, { role: 'togglefullscreen', label: t('menu.view.toggleFullScreen') },
        ] },
        { role: 'windowMenu', label: t('menu.window.title'), submenu: [
            { role: 'minimize', label: t('menu.window.minimize') }, { role: 'zoom', label: t('menu.window.zoom') },
            { type: 'separator' }, { role: 'front', label: t('menu.window.front') },
        ] },
        { role: 'help', label: t('menu.help.title'), submenu: [
            { id: 'rerun-documentation', label: t('menu.help.docs'), click: openDocumentation },
        ] },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
