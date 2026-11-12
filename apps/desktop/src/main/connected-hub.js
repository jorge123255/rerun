const form = document.querySelector('form')
const address = document.querySelector('#server-address')
const submit = form.querySelector('button')
const error = document.querySelector('#connection-error')
const picker = window.rerunHubPicker
const messages = {
    invalid: 'Enter an HTTPS address or an HTTP address on this Mac.',
    unreachable: 'Could not reach that server. Check the address and try again.',
    'not-rerun': 'This server did not identify itself as a Rerun hub.',
    unsupported: 'This server uses a different Rerun desktop protocol.',
    busy: 'Another connection is in progress. Try again shortly.',
}
void picker?.savedOrigin().then(origin => { if (!address.value && origin) address.value = origin }, () => {})
address.addEventListener('input', () => {
    error.hidden = true
    address.removeAttribute('aria-invalid')
})
form.addEventListener('submit', async event => {
    event.preventDefault()
    if (submit.disabled || !picker) return
    error.hidden = true
    submit.disabled = true
    address.disabled = true
    submit.textContent = 'Connecting…'
    try {
        const result = await picker.connect(address.value)
        if (result.ok) return
        error.textContent = result.reason === 'too-old' ? `This server requires Rerun ${result.minimum} or later.`
            : messages[result.reason] ?? messages.unreachable
    } catch { error.textContent = messages.unreachable }
    address.setAttribute('aria-invalid', 'true')
    address.disabled = false
    submit.disabled = false
    submit.textContent = 'Connect'
    error.hidden = false
    address.focus()
})
