import { fileURLToPath } from 'node:url'
import { shellLocale, shellText } from './shell-language.mjs'
import { QUICK_ASK_SHORTCUT } from './quick-ask-window.mjs'

const waitingLabels = {
    en: count => `${count} waiting for you`,
    fr: count => `${count} en attente de vous`,
    es: count => `${count} ${count === 1 ? 'te espera' : 'te esperan'}`,
    pt: count => `${count} esperando por você`,
    de: count => `${count} ${count === 1 ? 'wartet' : 'warten'} auf dich`,
}

export function macLoginItemSettings(app) {
    if (!app.isPackaged) return null
    try { return app.getLoginItemSettings() } catch { return null }
}

export function setMacOpenAtLogin(app, openAtLogin) {
    if (typeof openAtLogin !== 'boolean' || !macLoginItemSettings(app)) return
    try { app.setLoginItemSettings({ openAtLogin }) }
    catch { /* The OS setting remains authoritative if the change is refused. */ }
}

export function createMacMenuBar({ app, Menu, Tray, nativeImage, openWindow, quickAsk, updates, locale = () => app.getLocale() }) {
    const loginSettings = () => macLoginItemSettings(app)
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
        const language = shellLocale(locale()) ?? 'en'
        const t = shellText(language)
        const waiting = unread > 0 ? waitingLabels[language](unread) : null
        const login = loginSettings()
        const menu = Menu.buildFromTemplate([
            { id: 'rerun-tray-open', label: t('tray.open', { name: app.name }), click: openWindow },
            ...(quickAsk ? [{ id: 'rerun-tray-quick-ask', label: t('tray.quickAsk'), accelerator: QUICK_ASK_SHORTCUT,
                registerAccelerator: false, enabled: quickAsk.enabled(), click: () => { if (quickAsk.enabled()) quickAsk.open() } }] : []),
            ...(updates ? [{
                id: 'rerun-tray-updates', ...updates.menuItem(), click: () => { if (updates.menuItem().enabled) void updates.checkFromMenu() },
            }] : []),
            ...(waiting ? [{ id: 'rerun-tray-unread', label: waiting, enabled: false }] : []),
            { type: 'separator' },
            {
                id: 'rerun-tray-login', label: t('tray.openAtLogin'), type: 'checkbox',
                enabled: login !== null, checked: login?.openAtLogin === true,
                click: item => {
                    setMacOpenAtLogin(app, item.checked === true)
                    refresh()
                },
            },
            { type: 'separator' },
            { id: 'rerun-tray-quit', label: t('menu.app.quit', { name: app.name }), click: () => app.quit() },
        ])
        menu.on('menu-will-show', () => {
            const settings = loginSettings()
            const item = menu.getMenuItemById('rerun-tray-login')
            item.enabled = settings !== null
            if (settings) item.checked = settings.openAtLogin === true
            if (quickAsk) menu.getMenuItemById('rerun-tray-quick-ask').enabled = quickAsk.enabled()
        })
        tray.setContextMenu(menu)
        tray.setToolTip(waiting ? `${app.name} · ${waiting}` : app.name)
        tray.setTitle(unread > 99 ? '99+' : unread > 0 ? String(unread) : '')
    }
    try { refresh() } catch (error) { tray.destroy(); throw error }
    app.once('will-quit', () => tray.destroy())
    return {
        startedAtLogin, refresh,
        setUnread(count) {
            if (count === unread) return
            unread = count
            refresh()
        },
    }
}
