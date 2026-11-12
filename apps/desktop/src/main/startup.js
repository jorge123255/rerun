const message = document.getElementById('message')
const retry = document.getElementById('retry')
const runLocally = document.getElementById('run-locally')
const connectServer = document.getElementById('connect-server')
const localFootnote = document.getElementById('local-footnote')
const titlebar = document.getElementById('mac-titlebar')
if (window.desktopApp.onMacFullscreen) {
    titlebar.hidden = false
    window.desktopApp.onMacFullscreen(fullscreen => { titlebar.hidden = fullscreen })
}
function update(status) {
    message.textContent = status.message || (status.state === 'ready' ? 'Opening your workspace…' : 'Preparing your local workspace…')
    retry.hidden = status.state !== 'error'
    const choosing = status.state === 'choose' && !!status.choices
    runLocally.hidden = connectServer.hidden = !choosing
    localFootnote.hidden = choosing
    if (choosing) {
        runLocally.textContent = status.choices.local
        connectServer.textContent = status.choices.connect
    }
}
let waitingForStatus = true
window.desktopApp.onStatus(status => {
    waitingForStatus = false
    update(status)
})
window.desktopApp.getStatus().then(status => {
    if (waitingForStatus) update(status)
})
runLocally.addEventListener('click', () => { void window.desktopApp.openLocalWorkspace().catch(() => {}) })
connectServer.addEventListener('click', () => { void window.desktopApp.connectToServer().catch(() => {}) })
retry.addEventListener('click', () => { retry.hidden = true; window.desktopApp.retry().catch(() => update({ state: 'error', message: 'The local services could not restart. Quit and reopen the app.' })) })
document.getElementById('quit').addEventListener('click', () => window.desktopApp.quit())
