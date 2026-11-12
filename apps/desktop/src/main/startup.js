const message = document.getElementById('message')
const retry = document.getElementById('retry')
const defaultRetryLabel = retry.textContent
const runLocally = document.getElementById('run-locally')
const signInCloud = document.getElementById('sign-in-cloud')
const cloudError = document.getElementById('cloud-error')
const connectServer = document.getElementById('connect-server')
const localFootnote = document.getElementById('local-footnote')
const titlebar = document.getElementById('mac-titlebar')
let choices = null
if (window.desktopApp.onMacFullscreen) {
    titlebar.hidden = false
    window.desktopApp.onMacFullscreen(fullscreen => { titlebar.hidden = fullscreen })
}
function update(status) {
    message.textContent = status.message || (status.state === 'ready' ? 'Opening your workspace…' : 'Preparing your local workspace…')
    retry.hidden = status.state !== 'error'
    retry.textContent = status.retryLabel ?? defaultRetryLabel
    choices = status.choices ?? null
    runLocally.hidden = !choices?.local
    signInCloud.hidden = connectServer.hidden = !choices
    localFootnote.hidden = !!choices
    if (choices) {
        runLocally.textContent = choices.local ?? ''
        signInCloud.textContent = signInCloud.disabled ? choices.connecting : choices.cloud
        connectServer.textContent = choices.connect
    } else {
        cloudError.hidden = true
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
signInCloud.addEventListener('click', async () => {
    if (!choices || signInCloud.disabled) return
    signInCloud.disabled = true
    signInCloud.textContent = choices.connecting
    cloudError.hidden = true
    const result = await window.desktopApp.signInToCloud().catch(() => ({ ok: false }))
    signInCloud.disabled = false
    if (choices) {
        signInCloud.textContent = choices.cloud
        if (!result.ok) {
            cloudError.textContent = result.message ?? choices.unreachable
            cloudError.hidden = false
        }
    }
})
connectServer.addEventListener('click', () => { void window.desktopApp.connectToServer().catch(() => {}) })
retry.addEventListener('click', () => { retry.hidden = true; window.desktopApp.retry().catch(() => update({ state: 'error', message: 'The local services could not restart. Quit and reopen the app.' })) })
document.getElementById('quit').addEventListener('click', () => window.desktopApp.quit())
