export function installMacApplicationMenu({ Menu, appName, settingsWindow, isDesktopPage }) {
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
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
