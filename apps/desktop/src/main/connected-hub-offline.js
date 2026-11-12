const bridge = window.rerunHubOffline
const title = document.querySelector('#title')
const message = document.querySelector('#message')
const button = document.querySelector('#retry')
let issue = null
let inFlight = false

function render(value) {
    if (!value) return
    issue = value
    const { host, reason, minimum } = value
    title.textContent = reason === 'too-old' ? 'Update Rerun to continue' : 'Can’t reach Rerun'
    if (reason === 'too-old') message.textContent = `${host} requires Rerun ${minimum} or later.`
    else if (reason === 'not-rerun') message.textContent = `${host} did not identify itself as a Rerun hub.`
    else if (reason === 'unsupported') message.textContent = `${host} uses a different Rerun desktop protocol.`
    else if (reason === 'unavailable') message.textContent = `${host} is not answering right now. The app tries again on its own.`
    else message.textContent = `Check your connection. The app reconnects to ${host} on its own.`
}

async function retry(manual) {
    if (!bridge || inFlight || !issue || (!manual && !['offline', 'unavailable'].includes(issue.reason))) return
    inFlight = true
    if (manual) { button.disabled = true; button.textContent = 'Trying again…' }
    try { render(await bridge.retry()) }
    catch { /* Closing or replacing this page revokes its bridge. */ }
    finally {
        inFlight = false
        button.disabled = false
        button.textContent = 'Try again'
    }
}

bridge?.onState(render)
void bridge?.state().then(render, () => {})
button.disabled = !bridge
button.addEventListener('click', () => void retry(true))
window.addEventListener('online', () => void retry(false))
setInterval(() => void retry(false), 5000)
