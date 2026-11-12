import { sameHub } from './connected-hub-policy.mjs'

const stripeOrigins = new Set(['https://checkout.stripe.com', 'https://connect.stripe.com'])

function paymentAddress(raw) {
    try {
        const url = new URL(raw)
        return stripeOrigins.has(url.origin) && !url.username && !url.password ? url.href : null
    } catch { return null }
}

export function createHubPaymentWindows({ BrowserWindow, isCurrent, show, enabled }) {
    const active = new WeakMap()

    function close(entry) {
        const payment = active.get(entry)
        active.delete(entry)
        if (payment && !payment.window.isDestroyed()) payment.window.destroy()
    }

    function open(entry, raw) {
        if (!enabled) return false
        const address = paymentAddress(raw)
        if (!address || !isCurrent(entry) || !entry.window.isFocused()) return false
        const previous = active.get(entry)
        if (previous?.address === address) {
            show(previous.window)
            return true
        }
        close(entry)
        const frame = entry.contents.mainFrame
        const ownerUrl = frame.url
        const scope = entry.scope
        const window = new BrowserWindow({
            parent: entry.window, width: 560, height: 780, show: false, autoHideMenuBar: true,
            webPreferences: { session: entry.contents.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
        })
        const payment = { address, window }
        active.set(entry, payment)
        const current = () => active.get(entry) === payment && isCurrent(entry)
            && entry.scope === scope && entry.contents.mainFrame === frame && frame.url === ownerUrl
        const contents = window.webContents
        contents.setWindowOpenHandler(() => ({ action: 'deny' }))
        contents.on('will-attach-webview', event => event.preventDefault())
        const navigate = event => {
            if (event.isMainFrame === false) return
            if (current() && paymentAddress(event.url)) return
            event.preventDefault()
            if (current() && (!event.initiator || event.initiator === contents.mainFrame) && sameHub(event.url, entry.origin)) {
                // Return through the original window so its workspace session and unload guard still apply.
                close(entry)
                show(entry.window)
                void entry.recovery.navigate(event.url)
            }
        }
        contents.on('will-navigate', navigate)
        contents.on('will-redirect', navigate)
        window.once('ready-to-show', () => {
            if (current()) show(window)
            else if (active.get(entry) === payment) close(entry)
        })
        window.once('closed', () => { if (active.get(entry) === payment) active.delete(entry) })
        void window.loadURL(address).catch(() => { if (active.get(entry) === payment) close(entry) })
        return true
    }

    return { open, close }
}
