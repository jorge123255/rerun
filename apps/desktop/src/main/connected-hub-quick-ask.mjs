import { isHubPath, sameHub } from './connected-hub-policy.mjs'
import { focusQuickAsk, quickAskWindowOptions } from './quick-ask-window.mjs'

const path = '/quick-ask'

function isComposer(url, origin) {
    return sameHub(url, origin) && new URL(url).pathname === path
}

export function createConnectedHubQuickAsk({ app, BrowserWindow, screen, preload, current, showOwner, onUnavailable }) {
    let surface = null

    const active = entry => entry && surface === entry && !entry.window.isDestroyed()
        && current(entry.owner) && entry.owner.scope === entry.scope
    function reset(owner) {
        if (!surface || (owner && surface.owner !== owner)) return
        const { window } = surface
        surface = null
        if (!window.isDestroyed()) window.destroy()
    }
    function hide(entry) {
        entry.requested = false
        entry.window.hide()
    }
    function reveal(entry) {
        if (!active(entry) || !entry.loaded || !entry.requested) return
        entry.shownAt = Date.now()
        focusQuickAsk({ app, screen, window: entry.window })
    }

    return {
        reset,
        ownsWindow: window => !!surface && surface.window === window && active(surface),
        toggle(candidate, owner) {
            if (active(surface) && (candidate === surface.window || owner === surface.owner)) {
                if (surface.requested) hide(surface)
                else { surface.requested = true; reveal(surface) }
                return true
            }
            reset()
            if (!owner || !current(owner)) return false
            const window = new BrowserWindow(quickAskWindowOptions({ preload, session: owner.contents.session }))
            const entry = { owner, window, scope: owner.scope, requested: true, loaded: false, shownAt: 0 }
            surface = entry
            const contents = window.webContents
            window.setAlwaysOnTop(true, 'floating')
            window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
            window.on('blur', () => { if (active(entry) && Date.now() - entry.shownAt > 500) hide(entry) })
            window.on('closed', () => { if (surface === entry) surface = null })
            for (const event of ['will-navigate', 'will-redirect']) {
                contents.on(event, (request, target) => {
                    if (!isComposer(request.url ?? target, owner.origin)) request.preventDefault()
                })
            }
            contents.on('will-attach-webview', event => event.preventDefault())
            contents.setWindowOpenHandler(() => ({ action: 'deny' }))
            let responseStatus
            contents.on('did-navigate', (_event, _url, status) => { responseStatus = status })
            void window.loadURL(new URL(path, owner.origin).href).then(() => {
                if (!isComposer(contents.mainFrame?.url, owner.origin) || responseStatus >= 400) throw new Error('Invalid Quick Ask page')
                entry.loaded = true
                reveal(entry)
            }).catch(() => {
                if (!active(entry)) return
                const requested = entry.requested
                reset()
                if (requested) onUnavailable(owner)
            })
            return true
        },
        sender(event) {
            if (!active(surface) || event.sender !== surface.window.webContents || !event.senderFrame
                || event.senderFrame !== event.sender.mainFrame || !isComposer(event.senderFrame.url, surface.owner.origin)) return null
            return surface
        },
        close(entry) {
            if (active(entry)) hide(entry)
        },
        sent(entry, destination) {
            if (!active(entry) || !entry.requested || !isHubPath(destination)) return
            const { owner } = entry
            const target = new URL(destination, owner.origin)
            if (!sameHub(target, owner.origin)) return
            hide(entry)
            showOwner(owner)
            if (owner.contents.mainFrame?.url !== target.href) void owner.window.loadURL(target.href).catch(() => {})
        },
    }
}
