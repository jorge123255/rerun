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
    let surface, pending
    const registrations = new Map()
    const sameScope = (left, right) => !!left && !!right && left.epoch === right.epoch && left.contents === right.contents
    const active = entry => !!entry && entry === surface && sameScope(entry.scope, boardScope(entry.board))
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
    function invalidate(contents) {
        registrations.delete(contents)
        if (surface?.scope.contents === contents) reset()
    }
    function hide(entry) {
        entry.requested = false
        entry.window.hide()
    }
    function reveal(entry) {
        if (!active(entry) || !entry.requested || !entry.loaded) return
        entry.shownAt = Date.now()
        focusQuickAsk({ app, screen, window: entry.window })
        entry.window.webContents.send('desktop:quick-ask-focus', {
            ...shellCopy(language(), 'quickAsk'), appearance: boardScope(entry.board)?.appearance,
        })
    }

    return {
        ownsWindow: window => !!surface && surface.window === window && active(surface),
        toggle(board) {
            if (active(surface) && (surface.board === board || surface.window === board)) {
                if (surface.requested) hide(surface)
                else { surface.requested = true; reveal(surface) }
                return
            }
            const scope = boardScope(board)
            if (!scope || !sameScope(scope, registrations.get(scope.contents)) || pending) return
            reset()
            const window = new BrowserWindow(quickAskWindowOptions({ preload, partition: 'rerun-desktop-quick-ask' }))
            const entry = { window, board, scope, requested: true, loaded: false, shownAt: 0, attempt: null }
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
        invalidate,
        register(event, value, epoch) {
            if (!registration(value)) return
            const previous = registrations.get(event.sender)
            if (previous && previous.frame === event.senderFrame && previous.registrationId === value.registrationId && previous.epoch === epoch) return
            if (previous) invalidate(event.sender)
            registrations.set(event.sender, { contents: event.sender, frame: event.senderFrame, registrationId: value.registrationId, epoch })
        },
        unregister(event, value) {
            const ready = registrations.get(event.sender)
            if (ready && ready.frame === event.senderFrame && ready.registrationId === value?.registrationId) invalidate(event.sender)
        },
        close(event) { if (trusted(event)) hide(surface) },
        async send(event, text) {
            if (!trusted(event) || !surface.requested || pending
                || typeof text !== 'string' || text.length > 4000 || !text.trim()) return false
            const entry = surface
            const target = registrations.get(entry.scope.contents)
            if (!sameScope(entry.scope, target)) return false
            const prompt = text.trim()
            if (entry.attempt?.prompt !== prompt) entry.attempt = { prompt, requestId: randomUUID() }
            const { requestId } = entry.attempt
            const accepted = await new Promise(resolve => {
                pending = { requestId, target, resolve, timer: setTimeout(() => settle(false), 20_000) }
                try { target.frame.send('desktop:quick-ask-deliver', { ...entry.attempt, registrationId: target.registrationId }) }
                catch { settle(false) }
            })
            if (!accepted || !active(entry)) return false
            entry.attempt = null
            hide(entry)
            showBoard(entry.board)
            return true
        },
        acknowledge(event, value) {
            const ready = registrations.get(event.sender)
            if (pending && ready === pending.target && event.senderFrame === ready.frame
                && value?.registrationId === ready.registrationId && value.requestId === pending.requestId && active(surface)) {
                settle(value.accepted === true)
            }
        },
    }
}
