// A small "This Mac" button the app lays over the top of a cloud window. The window shows Rerun's
// own page, which the app does not change; this is a separate, sandboxed view with no script and no
// preload. A click is a navigation to one fixed address, which is caught here and never loaded.
const SWITCH_ADDRESS = 'rerun-local://open'
const WIDTH = 132, HEIGHT = 26, TOP = 5

const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export function localSwitchPage(label) {
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;font:500 12px -apple-system,BlinkMacSystemFont,sans-serif}
a{display:flex;align-items:center;justify-content:center;gap:6px;height:100%;box-sizing:border-box;border-radius:999px;text-decoration:none;cursor:default;
  color:#f4f4f5;background:rgba(39,39,42,.92);border:1px solid rgba(255,255,255,.14)}
a:hover{background:rgba(63,63,70,.96)}
a:focus-visible{outline:2px solid #818cf8;outline-offset:-2px}
@media (prefers-color-scheme: light){a{color:#18181b;background:rgba(244,244,245,.94);border-color:rgba(0,0,0,.12)}a:hover{background:rgba(228,228,231,.98)}}
</style><a href="${SWITCH_ADDRESS}" title="${escape(label)}"><span aria-hidden="true">&#8592;</span>${escape(label)}</a>`)
}

/** Where the button sits: centred in the strip above the page, clear of the traffic lights. */
export function localSwitchBounds(contentWidth) {
    const width = Math.min(WIDTH, Math.max(0, contentWidth - 200))
    return { x: Math.max(96, Math.round((contentWidth - width) / 2)), y: TOP, width, height: HEIGHT }
}

export function attachLocalSwitch({ WebContentsView, window, label, onOpen }) {
    if (!WebContentsView || !window?.contentView?.addChildView) return () => {}
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, partition: 'rerun-local-switch' } })
    view.setBackgroundColor('#00000000')
    const contents = view.webContents
    const refuse = (event, url) => { event.preventDefault(); if (url === SWITCH_ADDRESS) onOpen() }
    contents.on('will-navigate', refuse)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const place = () => { if (!window.isDestroyed()) view.setBounds(localSwitchBounds(window.getContentBounds().width)) }
    window.contentView.addChildView(view)
    place()
    window.on('resize', place)
    // A full-screen video or page takes the whole window; the button steps aside for it.
    window.on('enter-html-full-screen', () => view.setVisible(false))
    window.on('leave-html-full-screen', () => view.setVisible(true))
    void contents.loadURL(localSwitchPage(label)).catch(() => {})
    return () => {
        if (window.isDestroyed()) return
        window.removeListener('resize', place)
        window.contentView.removeChildView(view)
        if (!contents.isDestroyed()) contents.close()
    }
}
