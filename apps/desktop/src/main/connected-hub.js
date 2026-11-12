const form = document.querySelector('form')
const address = document.querySelector('#server-address')
const submit = form.querySelector('button')
const error = document.querySelector('#connection-error')
const picker = window.rerunHubPicker
const copy = picker?.copy
if (copy) {
    document.documentElement.lang = copy.locale
    document.title = copy.title
    document.querySelector('h1').textContent = copy.title
    document.querySelector('main > p').textContent = copy.description
    form.querySelector('label').textContent = copy.label
    submit.textContent = copy.connect
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
    submit.textContent = copy.connecting
    try {
        const result = await picker.connect(address.value)
        if (result.ok) return
        error.textContent = result.message ?? copy.unreachable
    } catch { error.textContent = copy.unreachable }
    address.setAttribute('aria-invalid', 'true')
    address.disabled = false
    submit.disabled = false
    submit.textContent = copy.connect
    error.hidden = false
    address.focus()
})
