import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { shellCopy } from './shell-language.mjs'

export const QUICK_ASK_SHORTCUT = 'CommandOrControl+Shift+Space'
const page = new URL('./quick-ask.html', import.meta.url)
const preload = fileURLToPath(new URL('./quick-ask-preload.cjs', import.meta.url))
const width = 640
const height = 180

export function quickAskWindowOptions(webPreferences) {
    return {
        width, height, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: true, hasShadow: true,
        backgroundColor: '#00000000', vibrancy: 'popover', visualEffectState: 'active',
        webPreferences: { ...webPreferences, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    }
}

export function focusQuickAsk({ app, screen, window }) {
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const actualWidth = Math.min(width, work.width)
    window.setBounds({ x: Math.round(work.x + (work.width - actualWidth) / 2),
        y: Math.round(work.y + work.height / 4), width: actualWidth, height })
    app.focus({ steal: true })
    window.show()
    window.focus()
    window.webContents.focus()
}

export function createQuickAskWindow({ app, BrowserWindow, screen, boardScope, showBoard, language = () => 'en' }) {
    let surface, ready, pending
    const sameScope = (left, right) => !!left && !!right && left.epoch === right.epoch && left.contents === right.contents
    const active = entry => !!entry && entry === surface && sameScope(entry.scope, boardScope())
    const trusted = event => active(surface) && event.sender === surface.window.webContents
        && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === page.href
    const registration = value => typeof value?.registrationId === 'string' && /^[0-9]{1,16}$/.test(value.registrationId)

    function settle(accepted) {
        if (!pending) return
        const reply = pending
        pending = null
        clearTimeout(reply.timer)
        reply.resolve(accepted)
    }
    function reset() {
        const entry = surface
        surface = null
        settle(false)
        if (entry && !entry.window.isDestroyed()) entry.window.destroy()
    }
    function hide(entry) {
        entry.requested = false
        entry.window.hide()
    }
    function reveal(entry) {
        if (!active(entry) || !entry.requested || !entry.loaded) return
        entry.shownAt = Date.now()
        focusQuickAsk({ app, screen, window: entry.window })
        entry.window.webContents.send('desktop:quick-ask-focus', shellCopy(language(), 'quickAsk'))
    }

    return {
        ownsWindow: window => !!surface && surface.window === window && active(surface),
        toggle() {
            const scope = boardScope()
            if (!sameScope(scope, ready)) return
            if (active(surface)) {
                if (surface.requested) hide(surface)
                else { surface.requested = true; reveal(surface) }
                return
            }
            reset()
            const window = new BrowserWindow(quickAskWindowOptions({ preload, partition: 'rerun-desktop-quick-ask' }))
            const entry = { window, scope, requested: true, loaded: false, shownAt: 0, attempt: null }
            surface = entry
            window.setAlwaysOnTop(true, 'floating')
            window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
            window.on('blur', () => { if (active(entry) && Date.now() - entry.shownAt > 500) hide(entry) })
            window.on('closed', () => { if (surface === entry) { surface = null; settle(false) } })
            for (const type of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
                window.webContents.on(type, event => event.preventDefault())
            }
            window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            void window.loadFile(fileURLToPath(page)).then(() => {
                entry.loaded = true
                reveal(entry)
            }).catch(() => { if (surface === entry) reset() })
        },
        reset,
        invalidate() { ready = null; reset() },
        register(event, value, epoch) {
            if (!registration(value)) return
            ready = { contents: event.sender, frame: event.senderFrame, registrationId: value.registrationId, epoch }
        },
        unregister(event, value) {
            if (!ready || ready.contents !== event.sender || ready.frame !== event.senderFrame || ready.registrationId !== value?.registrationId) return
            ready = null
            reset()
        },
        close(event) { if (trusted(event)) hide(surface) },
        async send(event, text) {
            if (!trusted(event) || !surface.requested || !sameScope(surface.scope, ready) || pending
                || typeof text !== 'string' || text.length > 4000 || !text.trim()) return false
            const entry = surface
            const prompt = text.trim()
            if (entry.attempt?.prompt !== prompt) entry.attempt = { prompt, requestId: randomUUID() }
            const target = ready
            const { requestId } = entry.attempt
            const accepted = await new Promise(resolve => {
                pending = { requestId, target, resolve, timer: setTimeout(() => settle(false), 20_000) }
                try { target.frame.send('desktop:quick-ask-deliver', { ...entry.attempt, registrationId: target.registrationId }) }
                catch { settle(false) }
            })
            if (!accepted || !active(entry)) return false
            entry.attempt = null
            hide(entry)
            showBoard()
            return true
        },
        acknowledge(event, value) {
            if (pending && ready === pending.target && event.sender === ready.contents && event.senderFrame === ready.frame
                && value?.registrationId === ready.registrationId && value.requestId === pending.requestId && sameScope(ready, boardScope())) {
                settle(value.accepted === true)
            }
        },
    }
}
