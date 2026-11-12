import { fileURLToPath } from 'node:url'

const page = new URL('./find.html', import.meta.url)
const preload = fileURLToPath(new URL('./find-preload.cjs', import.meta.url))
const width = 380, height = 52, margin = 12

export function createWindowFind({ WebContentsView, scopeOf }) {
    let current
    const active = entry => current === entry && !entry.view.webContents.isDestroyed() && scopeOf(entry.window) === entry.scope
    const trusted = event => current && active(current) && event.sender === current.view.webContents
        && event.senderFrame === current.view.webContents.mainFrame && event.senderFrame.url === page.href

    function close(window, focus = false) {
        if (!current || current.window !== window) return
        const entry = current
        current = null
        const { view, contents, layout, report, hide } = entry
        window.off('resize', layout)
        window.off('hide', hide)
        if (!contents.isDestroyed()) {
            contents.off('found-in-page', report)
            contents.stopFindInPage(focus ? 'keepSelection' : 'clearSelection')
        }
        if (!window.isDestroyed()) {
            window.contentView.removeChildView(view)
            if (focus && !contents.isDestroyed()) contents.focus()
        }
        if (!view.webContents.isDestroyed()) view.webContents.close()
    }

    return {
        open(window) {
            const scope = scopeOf(window)
            if (!scope) return
            if (current?.window === window && active(current)) {
                current.view.webContents.focus()
                current.view.webContents.send('desktop:find-focus')
                return
            }
            if (current) close(current.window)
            const contents = window.webContents
            const view = new WebContentsView({
                webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
                    partition: 'rerun-desktop-find' },
            })
            view.setBackgroundColor('#00000000')
            const layout = () => {
                const [available] = window.getContentSize()
                const actual = Math.min(width, Math.max(0, available - margin * 2))
                view.setBounds({ x: available - actual - margin, y: margin, width: actual, height })
            }
            const report = (_event, result) => {
                if (!active(entry) || !result.finalUpdate || entry.requestId === null || result.requestId !== entry.requestId) return
                view.webContents.send('desktop:find-result', { active: result.activeMatchOrdinal, total: result.matches })
            }
            const hide = () => close(window)
            const entry = { window, view, scope, contents, layout, report, hide, text: '', requestId: null }
            current = entry
            window.contentView.addChildView(view)
            layout()
            window.on('resize', layout)
            window.on('hide', hide)
            contents.on('found-in-page', report)
            for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview'])
                view.webContents.on(event, pending => pending.preventDefault())
            view.webContents.once('render-process-gone', () => { if (current === entry) close(window) })
            view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            void view.webContents.loadFile(fileURLToPath(page)).then(() => {
                if (active(entry)) view.webContents.focus()
                else if (current === entry) close(window)
            }).catch(() => { if (current === entry) close(window) })
        },
        search(event, input) {
            if (!trusted(event) || typeof input?.text !== 'string' || input.text.length > 500) return
            const text = input.text
            if (!text.trim()) {
                current.text = ''
                current.requestId = null
                current.contents.stopFindInPage('clearSelection')
                event.sender.send('desktop:find-result', { active: 0, total: 0 })
                return
            }
            const continuing = input.step === true && current.text === text
            current.text = text
            current.requestId = current.contents.findInPage(text, { forward: input.forward !== false, findNext: !continuing })
        },
        dismiss(event) { if (trusted(event)) close(current.window, true) },
        close,
    }
}
