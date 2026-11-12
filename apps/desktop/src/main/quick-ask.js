const form = document.querySelector('form')
const prompt = document.getElementById('prompt')
const status = document.getElementById('status')
const send = document.querySelector('button')
const hint = status.textContent
let sending = false

function update() { send.disabled = sending || !prompt.value.trim() }
window.desktopQuickAsk.onFocus(() => prompt.focus())
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
    status.textContent = 'Opening your conversation…'
    try {
        if (!await window.desktopQuickAsk.send(prompt.value)) throw new Error('Conversation unavailable')
        prompt.value = ''
        status.textContent = hint
    } catch {
        status.textContent = 'Could not open a conversation. Try again when the workspace is ready.'
    } finally {
        sending = false
        prompt.readOnly = false
        update()
    }
})
