import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const directory = dirname(fileURLToPath(import.meta.url))
const page = resolve(directory, 'mac-phone-pairing.html')

export function createPhonePairingWindow({ BrowserWindow, title }) {
    let current = null

    function close() {
        if (current && !current.isDestroyed()) current.close()
        current = null
    }

    return {
        page,
        close,
        open() {
            if (current && !current.isDestroyed()) {
                if (current.isMinimized()) current.restore()
                current.show()
                current.focus()
                return current
            }
            current = new BrowserWindow({
                width: 560,
                height: 640,
                title: title(),
                show: false,
                webPreferences: {
                    preload: resolve(directory, 'mac-phone-pairing-preload.cjs'),
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    webSecurity: true,
                    partition: 'rerun-desktop-phone-pairing',
                },
            })
            const opened = current
            opened.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            opened.webContents.on('will-navigate', event => event.preventDefault())
            opened.webContents.on('will-attach-webview', event => event.preventDefault())
            opened.on('closed', () => { if (current === opened) current = null })
            void opened.loadFile(page).then(() => {
                if (current !== opened || opened.isDestroyed()) return
                opened.show()
                opened.focus()
            }).catch(() => { if (!opened.isDestroyed()) opened.close() })
            return current
        },
        isTrusted(event) {
            return current && !current.isDestroyed() && event.senderFrame && event.sender === current.webContents
                && event.senderFrame === current.webContents.mainFrame
                && event.senderFrame.url === pathToFileURL(page).href
        },
    }
}
