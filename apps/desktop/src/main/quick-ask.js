const form = document.querySelector('form')
const prompt = document.getElementById('prompt')
const status = document.getElementById('status')
const send = document.querySelector('button')
let copy = {
    hint: status.textContent,
    opening: 'Opening your conversation…',
    unavailable: 'Could not open a conversation. Try again when the workspace is ready.',
}
let statusKey = 'hint'
function renderStatus(key = statusKey) {
    statusKey = key
    status.textContent = copy[key]
}
let sending = false

function update() { send.disabled = sending || !prompt.value.trim() }
window.desktopQuickAsk.onFocus(value => {
    if (value) {
        copy = value
        document.documentElement.lang = copy.locale
        document.title = copy.title
        prompt.placeholder = copy.placeholder
        prompt.setAttribute('aria-label', copy.placeholder)
        send.textContent = copy.send
        renderStatus()
    }
    prompt.focus()
})
prompt.addEventListener('input', update)
document.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); window.desktopQuickAsk.close() }
    if (event.target === prompt && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        form.requestSubmit()
    }
})
form.addEventListener('submit', async event => {
    event.preventDefault()
    if (send.disabled) return
    sending = true
    prompt.readOnly = true
    update()
    renderStatus('opening')
    try {
        if (!await window.desktopQuickAsk.send(prompt.value)) throw new Error('Conversation unavailable')
        prompt.value = ''
        renderStatus('hint')
    } catch {
        renderStatus('unavailable')
    } finally {
        sending = false
        prompt.readOnly = false
        update()
    }
})
