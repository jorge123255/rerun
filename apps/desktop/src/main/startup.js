const message = document.getElementById('message')
const retry = document.getElementById('retry')
const titlebar = document.getElementById('mac-titlebar')
if (window.desktopApp.onMacFullscreen) {
    titlebar.hidden = false
    window.desktopApp.onMacFullscreen(fullscreen => { titlebar.hidden = fullscreen })
}
function update(status) {
    message.textContent = status.message || (status.state === 'ready' ? 'Opening your workspace…' : 'Preparing your local workspace…')
    retry.hidden = status.state !== 'error'
}
window.desktopApp.getStatus().then(update)
window.desktopApp.onStatus(update)
retry.addEventListener('click', () => { retry.hidden = true; window.desktopApp.retry().catch(() => update({ state: 'error', message: 'The local services could not restart. Quit and reopen the app.' })) })
document.getElementById('quit').addEventListener('click', () => window.desktopApp.quit())
