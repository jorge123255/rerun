const form = document.querySelector('form')
const address = document.querySelector('#server-address')
const submit = form.querySelector('button[type="submit"]')
const cloud = document.querySelector('#connect-cloud')
const cancel = document.querySelector('#cancel')
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
    cloud.textContent = copy.useCloud
    cancel.textContent = copy.cancel
}
void picker?.initialOrigin().then(origin => { if (!address.value && origin) address.value = origin }, () => {})
address.addEventListener('input', () => {
    error.hidden = true
    address.removeAttribute('aria-invalid')
})
async function connect(useCloud) {
    if (submit.disabled || !picker) return
    error.hidden = true
    address.removeAttribute('aria-invalid')
    submit.disabled = cloud.disabled = address.disabled = true
    const button = useCloud ? cloud : submit
    button.textContent = copy.connecting
    try {
        const result = await (useCloud ? picker.connectCloud() : picker.connect(address.value))
        if (result.ok) return
        error.textContent = result.message ?? copy.unreachable
    } catch { error.textContent = copy.unreachable }
    if (!useCloud) address.setAttribute('aria-invalid', 'true')
    submit.disabled = cloud.disabled = address.disabled = false
    button.textContent = useCloud ? copy.useCloud : copy.connect
    error.hidden = false
    const retryTarget = useCloud ? cloud : address
    retryTarget.focus()
}
form.addEventListener('submit', event => {
    event.preventDefault()
    void connect(false)
})
cloud.addEventListener('click', () => { void connect(true) })
function dismiss() {
    void picker?.cancel().catch(() => {})
}
cancel.addEventListener('click', dismiss)
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
    event.preventDefault()
    dismiss()
})
