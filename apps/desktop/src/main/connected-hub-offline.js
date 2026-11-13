const bridge = window.rerunHubOffline
const title = document.querySelector('#title')
const message = document.querySelector('#message')
const button = document.querySelector('#retry')
const download = document.querySelector('#download')
const install = document.querySelector('#install')
const updateStatus = document.querySelector('#update-status')
const copy = bridge?.copy
const updater = bridge?.update
if (copy) {
    document.documentElement.lang = copy.locale
    document.documentElement.dataset.appearance = bridge.appearance
    document.title = title.textContent = copy.title
    button.textContent = copy.retry
    download.textContent = copy.download
    install.textContent = copy.restart
}
let issue = null
let inFlight = false
let update
let updateEventReceived = false

function renderUpdate() {
    const incompatible = issue?.reason === 'too-old'
    const status = update?.status
    install.hidden = !(incompatible && status === 'ready')
    download.hidden = !(incompatible && bridge?.download && install.hidden && status !== 'downloading')
    const text = incompatible && copy
        ? (bridge.appStore ? copy.appStore : { checking: copy.checking, downloading: copy.downloading, error: copy.failed }[status])
        : null
    updateStatus.textContent = text ?? ''
    updateStatus.hidden = !text
}

function render(value) {
    if (!value) return
    const becameIncompatible = issue?.reason !== 'too-old' && value.reason === 'too-old'
    issue = value
    document.title = title.textContent = value.title
    message.textContent = value.message
    renderUpdate()
    if (becameIncompatible && updater) {
        void updater.getState().then(state => {
            if (!updateEventReceived) { update = state; renderUpdate() }
        }).catch(() => {})
        void updater.check().catch(() => {})
    }
}

async function retry(manual) {
    if (!bridge || inFlight || !issue || (!manual && !['offline', 'unavailable'].includes(issue.reason))) return
    inFlight = true
    if (manual) { button.disabled = true; button.textContent = copy.retrying }
    try { render(await bridge.retry()) }
    catch { /* Closing or replacing this page revokes its bridge. */ }
    finally {
        inFlight = false
        button.disabled = false
        button.textContent = copy.retry
    }
}

bridge?.onState(render)
updater?.onState(state => { updateEventReceived = true; update = state; renderUpdate() })
void bridge?.state().then(render, () => {})
button.disabled = !bridge
button.addEventListener('click', () => void retry(true))
download.addEventListener('click', () => { void bridge?.download?.().catch(() => {}) })
install.addEventListener('click', async () => {
    if (install.disabled) return
    install.disabled = true
    try { await updater?.install() }
    catch { /* Closing the recovery page revokes the request. */ }
    finally { install.disabled = false }
})
window.addEventListener('online', () => void retry(false))
setInterval(() => void retry(false), 5000)
