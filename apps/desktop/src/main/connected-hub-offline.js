const bridge = window.rerunHubOffline
const title = document.querySelector('#title')
const message = document.querySelector('#message')
const button = document.querySelector('#retry')
const copy = bridge?.copy
if (copy) {
    document.documentElement.lang = copy.locale
    document.title = title.textContent = copy.title
    button.textContent = copy.retry
}
let issue = null
let inFlight = false

function render(value) {
    if (!value) return
    issue = value
    document.title = title.textContent = value.title
    message.textContent = value.message
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
void bridge?.state().then(render, () => {})
button.disabled = !bridge
button.addEventListener('click', () => void retry(true))
window.addEventListener('online', () => void retry(false))
setInterval(() => void retry(false), 5000)
