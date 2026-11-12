import { fileURLToPath } from 'node:url'

const labels = {
    en: { open: name => `Open ${name}`, waiting: count => `${count} waiting for you`, login: 'Open at Login', quit: name => `Quit ${name}` },
    fr: { open: name => `Ouvrir ${name}`, waiting: count => `${count} en attente de vous`, login: 'Ouvrir à la connexion', quit: name => `Quitter ${name}` },
    es: { open: name => `Abrir ${name}`, waiting: count => `${count} ${count === 1 ? 'te espera' : 'te esperan'}`, login: 'Abrir al iniciar sesión', quit: name => `Salir de ${name}` },
    pt: { open: name => `Abrir o ${name}`, waiting: count => `${count} esperando por você`, login: 'Abrir ao iniciar sessão', quit: name => `Sair do ${name}` },
    de: { open: name => `${name} öffnen`, waiting: count => `${count} ${count === 1 ? 'wartet' : 'warten'} auf dich`, login: 'Bei der Anmeldung öffnen', quit: name => `${name} beenden` },
}

export function createMacMenuBar({ app, Menu, Tray, nativeImage, openWindow }) {
    const language = app.getLocale().toLowerCase().split('-')[0]
    const copy = Object.hasOwn(labels, language) ? labels[language] : labels.en
    const loginSettings = () => {
        if (!app.isPackaged) return null
        try { return app.getLoginItemSettings() } catch { return null }
    }
    const image = nativeImage.createEmpty()
    for (const [scaleFactor, suffix] of [[1, ''], [2, '@2x']]) {
        const path = fileURLToPath(new URL(`./tray/trayTemplate${suffix}.png`, import.meta.url))
        const representation = nativeImage.createFromPath(path)
        if (representation.isEmpty()) throw new Error('Missing menu-bar icon')
        image.addRepresentation({ scaleFactor, buffer: representation.toPNG() })
    }
    image.setTemplateImage(true)

    let unread = 0
    const startedAtLogin = loginSettings()?.wasOpenedAtLogin === true
    const tray = new Tray(image)
    function refresh() {
        const waiting = unread > 0 ? copy.waiting(unread) : null
        const login = loginSettings()
        const menu = Menu.buildFromTemplate([
            { id: 'rerun-tray-open', label: copy.open(app.name), click: openWindow },
            ...(waiting ? [{ id: 'rerun-tray-unread', label: waiting, enabled: false }] : []),
            { type: 'separator' },
            {
                id: 'rerun-tray-login', label: copy.login, type: 'checkbox',
                enabled: login !== null, checked: login?.openAtLogin === true,
                click: item => {
                    if (!loginSettings()) return
                    try { app.setLoginItemSettings({ openAtLogin: item.checked === true }) }
                    catch { /* The OS setting remains authoritative if the change is refused. */ }
                    refresh()
                },
            },
            { type: 'separator' },
            { id: 'rerun-tray-quit', label: copy.quit(app.name), click: () => app.quit() },
        ])
        menu.on('menu-will-show', () => {
            const settings = loginSettings()
            const item = menu.getMenuItemById('rerun-tray-login')
            item.enabled = settings !== null
            if (settings) item.checked = settings.openAtLogin === true
        })
        tray.setContextMenu(menu)
        tray.setToolTip(waiting ? `${app.name} · ${waiting}` : app.name)
        tray.setTitle(unread > 99 ? '99+' : unread > 0 ? String(unread) : '')
    }
    try { refresh() } catch (error) { tray.destroy(); throw error }
    app.once('will-quit', () => tray.destroy())
    return {
        startedAtLogin,
        setUnread(count) {
            if (count === unread) return
            unread = count
            refresh()
        },
    }
}
