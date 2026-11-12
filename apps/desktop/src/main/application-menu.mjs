import { QUICK_ASK_SHORTCUT } from './quick-ask-window.mjs'

export function installMacApplicationMenu({ Menu, appName, settingsWindow, isDesktopPage, openDocumentation, openFind, openQuickAsk, openNewWindow, openHubPicker }) {
    const template = [
        { label: appName, submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
                id: 'rerun-settings',
                label: 'Settings…',
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
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
        ] },
        { role: 'fileMenu', submenu: [
            { id: 'rerun-new-window', label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: openNewWindow },
            { id: 'rerun-connect-hub', label: 'Connect to Rerun…', click: openHubPicker },
            { id: 'rerun-quick-ask', label: 'Quick Ask…', accelerator: QUICK_ASK_SHORTCUT, registerAccelerator: false, click: openQuickAsk },
            { type: 'separator' }, { role: 'close' },
        ] },
        { role: 'editMenu', submenu: [
            { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
            { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
            { role: 'delete' }, { role: 'selectAll' }, { type: 'separator' },
            { id: 'rerun-find', label: 'Find…', click: openFind },
        ] },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        { role: 'help', submenu: [
            { id: 'rerun-documentation', label: 'Rerun Documentation', click: openDocumentation },
        ] },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
